/**
 * Message Archive Management (XEP-0313) module.
 *
 * Provides unified archive querying for both 1:1 conversations and MUC rooms.
 * Handles result collection, pagination, and applying modifications (retractions,
 * corrections, fastenings, reactions) to archived messages.
 *
 * ## Loading Strategy
 *
 * MAM queries follow a hybrid lazy + background approach:
 *
 * 1. **On connect (fast)**: Preview refresh fetches the latest message for each
 *    conversation to update sidebar previews (max=5, concurrency=3).
 * 2. **On connect (slow)**: Background catch-up populates full message history
 *    for all conversations and rooms (max=100, concurrency=2).
 * 3. **On connect (discovery)**: Query MAM for roster contacts that don't have an
 *    existing conversation, discovering messages received while offline.
 * 4. **On conversation open**: Side effects trigger a MAM query with `start` filter
 *    to fetch any remaining messages newer than the most recent cached message.
 * 5. **On scroll up**: `fetchOlderHistory()` queries MAM with `before` cursor for
 *    older messages (pagination).
 *
 * This approach balances fast connection time with having messages ready when
 * the user opens any conversation.
 *
 * @module MAM
 * @category Modules
 */

import { xml, Element } from '@xmpp/client'
import { BaseModule } from './BaseModule'
import { getBareJid, getResource, getLocalPart } from '../jid'
import { generateUUID, generateStableMessageId } from '../../utils/uuid'
import { executeWithConcurrency } from '../../utils/concurrencyUtils'
import { parseRSMResponse } from '../../utils/rsm'
import {
  findNewestMessage,
  buildCatchUpStartTime,
  isConnectionError,
  MAM_CATCHUP_FORWARD_MAX,
  MAM_CATCHUP_BACKWARD_MAX,
  MAM_CACHE_LOAD_LIMIT,
  MAM_ROOM_FORWARD_MAX_PAGES,
} from '../../utils/mamCatchUpUtils'
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
  NS_OCCUPANT_ID,
  NS_POLL,
} from '../namespaces'
import { parsePollElement, parsePollClosedElement } from '../poll'
import type {
  Message,
  RoomMessage,
  MAMQueryOptions,
  MAMResult,
  RoomMAMQueryOptions,
  RoomMAMResult,
  RSMResponse,
  MAMSearchOptions,
  RoomMAMSearchOptions,
  MAMPagingSearchOptions,
} from '../types'
import { parseMessageContent, parseOgpFastening, applyRetraction, applyCorrection, parseStanzaId } from './messagingUtils'
import { getDomain } from '../jid'
import { logInfo, logError as logErr } from '../logger'
import { parseSearchQuery, tokenize } from '../../utils/searchIndex'

/**
 * Internal type for collected modifications during MAM query
 */
interface MAMModifications {
  retractions: { targetId: string; from: string }[]
  corrections: { targetId: string; from: string; body: string; messageEl: Element; correctionStanzaId?: string }[]
  fastenings: { targetId: string; applyToEl: Element }[]
  reactions: { targetId: string; from: string; emojis: string[]; timestamp?: Date }[]
}

/**
 * Modifications that could not be applied to messages within the current MAM page.
 * These target messages already in the store/cache and need to be emitted as events.
 */
interface UnresolvedModifications {
  retractions: { targetId: string; from: string }[]
  corrections: { targetId: string; from: string; body: string; messageEl: Element; correctionStanzaId?: string }[]
  fastenings: { targetId: string; applyToEl: Element }[]
  reactions: { targetId: string; from: string; emojis: string[]; timestamp?: Date }[]
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
    const mamStart = Date.now()

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

        const collectMessage = this.createMessageCollector(queryId, (forwarded, messageEl, archiveId) => {
          // Check for modifications first
          const forwardedTimestamp = this.extractForwardedTimestamp(forwarded)
          if (this.collectModification(messageEl, modifications, (from) => getBareJid(from), forwardedTimestamp)) {
            return
          }

          const msg = this.parseArchiveMessage(forwarded, conversationId, archiveId)
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
          if (page === 0) {
            logInfo(`MAM query: ...@${getDomain(conversationId) || '*'}, max=${max}, ${start ? 'forward' : 'backward'}${start ? ` from ${start}` : ''}`)
          }
          const response = await this.deps.sendIQ(iq)
          const { complete, rsm } = this.parseMAMResponse(response)

          // Apply modifications to collected messages
          const unresolved = this.applyModifications(collectedMessages, modifications, (msg, from) => msg.from === from)

          // Emit modifications targeting messages already in the store (from prior queries/cache)
          this.emitUnresolvedChatModifications(conversationId, unresolved)

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

      logInfo(`MAM result: ...@${getDomain(conversationId) || '*'} → ${allMessages.length} msg(s), complete=${isComplete}, ${Date.now() - mamStart}ms`)

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
      if (isConnectionError(error)) {
        logInfo(`MAM skipped: ...@${getDomain(conversationId) || '*'} — ${msg}`)
      } else {
        logErr(`MAM error: ...@${getDomain(conversationId) || '*'} — ${msg}`)
      }
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
    const roomMamStart = Date.now()
    const isForward = !!start
    const roomDirection = isForward ? 'forward' : 'backward'

    // For forward catch-up queries, auto-paginate to retrieve all missed messages.
    // Backward queries (scroll-up) remain single-page — the caller controls pagination.
    const maxAutoPages = isForward ? MAM_ROOM_FORWARD_MAX_PAGES : 1
    const allMessages: RoomMessage[] = []
    let isComplete = false
    let lastRsm: RSMResponse = {}
    let currentAfter = after

    const room = this.deps.stores?.room.getRoom(roomJid)
    const myNickname = room?.nickname || ''

    this.deps.emitSDK('room:mam-loading', { roomJid, isLoading: true })

    try {
      for (let page = 0; page < maxAutoPages; page++) {
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
        const iq = this.buildMAMQuery(queryId, formFields, max, before, roomJid, currentAfter)

        const collectedMessages: RoomMessage[] = []
        const modifications: MAMModifications = { retractions: [], corrections: [], fastenings: [], reactions: [] }

        const collectMessage = this.createMessageCollector(queryId, (forwarded, messageEl, archiveId) => {
          // Check for modifications first (keep full JID for room messages)
          const forwardedTimestamp = this.extractForwardedTimestamp(forwarded)
          if (this.collectModification(messageEl, modifications, (from) => from, forwardedTimestamp)) {
            return
          }

          const msg = this.parseRoomArchiveMessage(forwarded, roomJid, myNickname, archiveId)
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

        try {
          if (page === 0) {
            logInfo(`Room MAM query: ${roomJid}, max=${max}, ${roomDirection}${start ? ` from ${start}` : ''}`)
          }
          const response = await this.deps.sendIQ(iq)
          const { complete, rsm } = this.parseMAMResponse(response)

          // Apply modifications to collected messages (full JID comparison for rooms)
          // normalizeReactor extracts nick from full MUC JID for consistent reactor identifiers
          const unresolved = this.applyModifications(
            collectedMessages, modifications,
            (msg, from) => msg.from === from,
            (from) => getResource(from) || from
          )

          // Emit modifications targeting messages already in the store (from prior queries/cache)
          this.emitUnresolvedRoomModifications(roomJid, unresolved)

          // Emit each page's messages immediately so the store can update incrementally
          const direction = isForward ? 'forward' : 'backward'
          this.deps.emitSDK('room:mam-messages', {
            roomJid,
            messages: collectedMessages,
            rsm,
            complete,
            direction,
          })

          allMessages.push(...collectedMessages)
          isComplete = complete
          lastRsm = rsm

          // Stop if archive is complete (no more messages)
          if (complete) {
            break
          }

          // For forward pagination: use `last` as the next `after` cursor
          if (isForward && rsm.last) {
            currentAfter = rsm.last
          } else {
            // No pagination cursor or single-page mode — stop
            break
          }
        } finally {
          unregister()
        }
      }

      logInfo(`Room MAM result: ${roomJid} → ${allMessages.length} msg(s), complete=${isComplete}, ${Date.now() - roomMamStart}ms`)

      return { messages: allMessages, complete: isComplete, rsm: lastRsm }
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error'
      if (isConnectionError(error)) {
        logInfo(`Room MAM skipped: ${roomJid} — ${msg}`)
      } else {
        logErr(`Room MAM error: ${roomJid} — ${msg}`)
      }
      this.deps.emitSDK('room:mam-error', { roomJid, error: msg })
      throw error
    } finally {
      this.deps.emitSDK('room:mam-loading', { roomJid, isLoading: false })
    }
  }

  // ============================================================================
  // MAM Fulltext Search
  // ============================================================================

  /**
   * Search the message archive using server-side fulltext search.
   *
   * Requires server support for the `fulltext` form field in MAM queries
   * (supported by ejabberd and some other servers). Use
   * `connectionStore.mamFulltextSearch` to check availability.
   *
   * @param options - Search options
   * @returns Messages matching the query, with pagination info
   */
  async searchArchive(options: MAMSearchOptions): Promise<MAMResult> {
    const { query, with: withJid, max = 20, before } = options
    const queryId = `mam_search_${generateUUID()}`

    const formFields: Element[] = [
      xml('field', { var: 'FORM_TYPE', type: 'hidden' }, xml('value', {}, NS_MAM)),
      xml('field', { var: 'fulltext' }, xml('value', {}, query)),
    ]

    if (withJid) {
      const conversationId = getBareJid(withJid)
      formFields.push(xml('field', { var: 'with' }, xml('value', {}, conversationId)))
    }

    const iq = this.buildMAMQuery(queryId, formFields, max, before ?? '')

    const collectedMessages: Message[] = []
    const modifications: MAMModifications = { retractions: [], corrections: [], fastenings: [], reactions: [] }

    const collectMessage = this.createMessageCollector(queryId, (forwarded, messageEl, archiveId) => {
      const forwardedTimestamp = this.extractForwardedTimestamp(forwarded)
      if (this.collectModification(messageEl, modifications, (from) => getBareJid(from), forwardedTimestamp)) {
        return
      }
      // Derive conversationId from the message's from/to
      const currentJid = this.deps.getCurrentJid()
      const from = getBareJid(messageEl.attrs.from || '')
      const to = getBareJid(messageEl.attrs.to || '')
      const ownBareJid = currentJid ? getBareJid(currentJid) : ''
      const conversationId = from === ownBareJid ? to : from

      const msg = this.parseArchiveMessage(forwarded, conversationId, archiveId)
      if (msg) collectedMessages.push(msg)
    })

    let unregister: () => void
    if (this.deps.registerMAMCollector) {
      unregister = this.deps.registerMAMCollector(queryId, collectMessage)
    } else {
      const xmpp = this.deps.getXmpp()
      xmpp?.on('stanza', collectMessage)
      unregister = () => xmpp?.removeListener('stanza', collectMessage)
    }

    try {
      logInfo(`MAM search: query="${query}"${withJid ? `, with=${getBareJid(withJid)}` : ''}, max=${max}`)
      const response = await this.deps.sendIQ(iq)
      const { complete, rsm } = this.parseMAMResponse(response)

      this.applyModifications(collectedMessages, modifications, (msg, from) => msg.from === from)

      logInfo(`MAM search result: ${collectedMessages.length} msg(s), complete=${complete}`)
      return { messages: collectedMessages, complete, rsm }
    } finally {
      unregister()
    }
  }

  /**
   * Search a room's message archive using server-side fulltext search.
   *
   * @param options - Search options
   * @returns Room messages matching the query, with pagination info
   */
  async searchRoomArchive(options: RoomMAMSearchOptions): Promise<RoomMAMResult> {
    const { query, roomJid, max = 20, before } = options
    const queryId = `mam_rsearch_${generateUUID()}`

    const room = this.deps.stores?.room.getRoom(roomJid)
    const myNickname = room?.nickname || ''

    const formFields: Element[] = [
      xml('field', { var: 'FORM_TYPE', type: 'hidden' }, xml('value', {}, NS_MAM)),
      xml('field', { var: 'fulltext' }, xml('value', {}, query)),
    ]

    const iq = this.buildMAMQuery(queryId, formFields, max, before ?? '', roomJid)

    const collectedMessages: RoomMessage[] = []
    const modifications: MAMModifications = { retractions: [], corrections: [], fastenings: [], reactions: [] }

    const collectMessage = this.createMessageCollector(queryId, (forwarded, messageEl, archiveId) => {
      const forwardedTimestamp = this.extractForwardedTimestamp(forwarded)
      if (this.collectModification(messageEl, modifications, (from) => from, forwardedTimestamp)) {
        return
      }
      const msg = this.parseRoomArchiveMessage(forwarded, roomJid, myNickname, archiveId)
      if (msg) collectedMessages.push(msg)
    })

    let unregister: () => void
    if (this.deps.registerMAMCollector) {
      unregister = this.deps.registerMAMCollector(queryId, collectMessage)
    } else {
      const xmpp = this.deps.getXmpp()
      xmpp?.on('stanza', collectMessage)
      unregister = () => xmpp?.removeListener('stanza', collectMessage)
    }

    try {
      logInfo(`Room MAM search: query="${query}", room=${roomJid}, max=${max}`)
      const response = await this.deps.sendIQ(iq)
      const { complete, rsm } = this.parseMAMResponse(response)

      this.applyModifications(collectedMessages, modifications, (msg, from) => msg.from === from)

      logInfo(`Room MAM search result: ${collectedMessages.length} msg(s), complete=${complete}`)
      return { messages: collectedMessages, complete, rsm }
    } finally {
      unregister()
    }
  }

  /**
   * Search a conversation by paging through MAM history and matching client-side.
   *
   * Used when the server doesn't support fulltext MAM search. Pages backward
   * through the archive, tokenizes each message body, and collects matches.
   *
   * @param options - Search options
   * @param signal - Optional AbortSignal to cancel the search
   * @returns Matching messages
   */
  async searchConversationByPaging(
    options: MAMPagingSearchOptions,
    signal?: AbortSignal
  ): Promise<MAMResult> {
    const { query, with: withJid, end, maxPages = 20, maxResults = 50 } = options
    const parsed = parseSearchQuery(query)
    const phraseTokens = parsed.phrases.flatMap((p) => tokenize(p))
    const allTokens = [...new Set([...parsed.terms, ...phraseTokens])]
    if (allTokens.length === 0 && parsed.phrases.length === 0) {
      return { messages: [], complete: true, rsm: {} }
    }

    const matches: Message[] = []
    let beforeCursor: string | undefined
    let isComplete = false
    let lastRsm: RSMResponse = {}

    logInfo(`MAM paging search: query="${query}", with=${withJid}, maxPages=${maxPages}`)

    for (let page = 0; page < maxPages; page++) {
      if (signal?.aborted) break
      if (matches.length >= maxResults) break

      const result = await this.queryArchive({
        with: withJid,
        max: 100,
        before: beforeCursor ?? '',
        ...(page === 0 && end ? { end } : {}),
      })

      isComplete = result.complete
      lastRsm = result.rsm

      // Match messages client-side
      for (const msg of result.messages) {
        if (matches.length >= maxResults) break
        if (msg.body && this.matchesQuery(msg.body, allTokens, parsed.phrases)) {
          matches.push(msg)
        }
      }

      if (isComplete || !result.rsm.first) break
      beforeCursor = result.rsm.first

      // Small delay between pages to avoid overwhelming the server
      await new Promise(resolve => setTimeout(resolve, 100))
    }

    logInfo(`MAM paging search result: scanned to find ${matches.length} match(es), complete=${isComplete}`)
    return { messages: matches, complete: isComplete, rsm: lastRsm }
  }

  /**
   * Check if a message body matches all query tokens and exact phrases.
   */
  private matchesQuery(body: string, queryTokens: string[], phrases: string[] = []): boolean {
    const bodyLower = body.toLowerCase()
    const tokensMatch = queryTokens.every(token => bodyLower.includes(token))
    if (!tokensMatch) return false
    return phrases.every(phrase => bodyLower.includes(phrase))
  }

  /**
   * Fetch context messages around a target timestamp from MAM and store in cache.
   *
   * Used by SearchContextView when previewing MAM search results — the target
   * message may not be in the local cache yet.
   *
   * @param conversationId - Conversation JID
   * @param isRoom - Whether this is a MUC room
   * @param targetTimestamp - ISO 8601 timestamp of the target message
   * @param contextSize - Number of messages to fetch on each side (default 50)
   * @returns Messages around the target
   */
  async fetchContext(
    conversationId: string,
    isRoom: boolean,
    targetTimestamp: string,
    contextSize: number = 50
  ): Promise<{ messages: (Message | RoomMessage)[] }> {
    // Fetch messages before and after the target timestamp
    const oneHourBefore = new Date(new Date(targetTimestamp).getTime() - 3600000).toISOString()

    if (isRoom) {
      const result = await this.queryRoomArchive({
        roomJid: conversationId,
        max: contextSize * 2,
        start: oneHourBefore,
      })
      return { messages: result.messages }
    } else {
      const result = await this.queryArchive({
        with: conversationId,
        max: contextSize * 2,
        start: oneHourBefore,
        end: new Date(new Date(targetTimestamp).getTime() + 3600000).toISOString(),
      })
      return { messages: result.messages }
    }
  }

  /**
   * Catch up conversation history backward from the oldest locally-cached message
   * until we reach (or pass) the target timestamp. Stores results in messageCache
   * and search index but NOT in the in-memory store.
   *
   * This fills the gap between locally-cached messages and a MAM search result,
   * ensuring the conversation history is continuous.
   *
   * @param conversationId - Conversation JID
   * @param isRoom - Whether this is a MUC room
   * @param targetTimestamp - ISO 8601 timestamp to catch up to
   * @param oldestCachedTimestamp - ISO 8601 timestamp of oldest locally-cached message (or undefined to start from now)
   */
  async catchUpToTimestamp(
    conversationId: string,
    isRoom: boolean,
    targetTimestamp: string,
    oldestCachedTimestamp?: string
  ): Promise<void> {
    const targetTime = new Date(targetTimestamp).getTime()
    const maxPages = 30 // Safety cap

    logInfo(`MAM catch-up to ${targetTimestamp} for ${conversationId}`)

    for (let page = 0; page < maxPages; page++) {
      const endFilter = page === 0 && oldestCachedTimestamp
        ? oldestCachedTimestamp
        : undefined

      if (isRoom) {
        const result = await this.queryRoomArchive({
          roomJid: conversationId,
          max: 100,
          before: page === 0 ? '' : undefined,
          ...(endFilter ? {} : {}), // For rooms, we rely on RSM pagination
        })
        // Check if we've reached the target
        const oldestInPage = result.messages.length > 0
          ? result.messages[0].timestamp.getTime()
          : targetTime
        if (result.complete || oldestInPage <= targetTime) break
      } else {
        const result = await this.queryArchive({
          with: conversationId,
          max: 100,
          ...(endFilter ? { end: endFilter } : {}),
          before: '',
        })
        // Check if we've reached the target
        const oldestInPage = result.messages.length > 0
          ? result.messages[0].timestamp.getTime()
          : targetTime
        if (result.complete || oldestInPage <= targetTime) break
      }

      // Small delay between pages
      await new Promise(resolve => setTimeout(resolve, 100))
    }

    logInfo(`MAM catch-up complete for ${conversationId}`)
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

    logInfo(`Preview refresh for ${conversations.length} conversation(s)`)

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

    logInfo(`Preview refresh complete for ${conversations.length} conversation(s)`)
  }

  /**
   * Refresh sidebar previews for archived conversations and auto-unarchive
   * those with new incoming messages.
   *
   * This is meant to run periodically (e.g., once per day) to detect activity
   * in archived conversations that occurred on other clients while Fluux was
   * offline. When a newer incoming message is found, the conversation is
   * automatically unarchived so it appears in the main sidebar.
   *
   * @param options - Optional configuration
   * @param options.concurrency - Maximum parallel requests (default: 3)
   */
  async refreshArchivedConversationPreviews(options: { concurrency?: number } = {}): Promise<void> {
    const { concurrency = 3 } = options
    const archivedConversations = this.deps.stores?.chat.getArchivedConversations?.() || []
    if (archivedConversations.length === 0) return

    this.deps.emitSDK('console:event', {
      message: `Checking ${archivedConversations.length} archived conversation(s) for new activity`,
      category: 'sm',
    })

    const conversationIds = archivedConversations.map((c) => c.id)

    await executeWithConcurrency(
      conversationIds,
      (conversationId) => this.fetchPreviewForConversation(conversationId, { unarchiveIfNewer: true }),
      concurrency
    )
  }

  /**
   * Background catch-up for all non-archived conversations.
   *
   * After being offline, this fetches the full message history (not just previews)
   * for all conversations so messages are ready when the user opens them.
   *
   * Uses forward queries from the newest cached message, matching the proven
   * pattern from sideEffects' lazy MAM loading. Runs with low concurrency
   * to avoid overwhelming the server.
   *
   * @param options - Optional configuration
   * @param options.concurrency - Maximum parallel requests (default: 2)
   * @param options.exclude - Conversation ID to skip (e.g., the active conversation already handled by side effects)
   */
  async catchUpAllConversations(options: { concurrency?: number; exclude?: string | null } = {}): Promise<void> {
    const { concurrency = 2, exclude } = options
    let conversations = this.deps.stores?.chat.getAllConversations() || []
    if (exclude) {
      conversations = conversations.filter((c) => c.id !== exclude)
    }
    if (conversations.length === 0) return

    logInfo(`Background catch-up for ${conversations.length} conversation(s)`)

    this.deps.emitSDK('console:event', {
      message: `Background catch-up for ${conversations.length} conversation(s)`,
      category: 'sm',
    })

    await executeWithConcurrency(
      conversations,
      async (conv) => {
        try {
          // Skip if disconnected (avoid queuing doomed queries)
          if (this.deps.stores?.connection.getStatus() !== 'online') return

          // Load IndexedDB cache first so we know the newest cached message
          // and can do a proper forward catch-up instead of fetching only latest.
          // Without this, conv.messages is empty after app restart (runtime-only),
          // causing a backward "before:''" query that creates gaps with old cache.
          await this.deps.stores?.chat.loadMessagesFromCache?.(conv.id, { limit: MAM_CACHE_LOAD_LIMIT })

          // Re-read messages after cache load (store was mutated)
          const updatedConv = this.deps.stores?.chat.getAllConversations()?.find(c => c.id === conv.id)
          const messages = updatedConv?.messages || conv.messages || []
          const newestMessage = findNewestMessage(messages)

          if (newestMessage?.timestamp) {
            // Forward query from the last known message
            await this.queryArchive({
              with: conv.id,
              start: buildCatchUpStartTime(newestMessage.timestamp),
              max: MAM_CATCHUP_FORWARD_MAX,
            })
          } else {
            // No messages (empty) — fetch latest from MAM
            await this.queryArchive({
              with: conv.id,
              before: '',
              max: MAM_CATCHUP_BACKWARD_MAX,
            })
          }
        } catch (_error) {
          // Silently ignore — individual failures shouldn't affect others
        }
      },
      concurrency
    )

    logInfo(`Background catch-up for ${conversations.length} conversation(s) — complete`)
  }

  /**
   * Discover new conversations from roster contacts.
   *
   * Roster contacts who sent messages while the user was offline won't have
   * a conversation entry in the store. This method queries MAM for each roster
   * contact that doesn't already have a conversation, creating conversation
   * entries for those with messages.
   *
   * Uses a preview-style query (max=5) to keep it lightweight — the full
   * catch-up will be handled by the next connection cycle or lazy loading
   * when the user opens the conversation.
   *
   * @param options - Optional configuration
   * @param options.concurrency - Maximum parallel requests (default: 2)
   */
  async discoverNewConversationsFromRoster(options: { concurrency?: number } = {}): Promise<void> {
    const { concurrency = 2 } = options
    const contacts = this.deps.stores?.roster.sortedContacts() || []
    if (contacts.length === 0) return

    // Filter to contacts that don't already have a conversation (active or archived)
    const newContacts = contacts.filter(
      (contact) => !this.deps.stores?.chat.hasConversation(contact.jid)
    )
    if (newContacts.length === 0) return

    logInfo(`Roster discovery for ${newContacts.length} contact(s)`)

    this.deps.emitSDK('console:event', {
      message: `Discovering conversations for ${newContacts.length} roster contact(s)`,
      category: 'sm',
    })

    await executeWithConcurrency(
      newContacts,
      async (contact) => {
        try {
          if (this.deps.stores?.connection.getStatus() !== 'online') return

          const result = await this.queryArchive({
            with: contact.jid,
            before: '',
            max: 5,
          })

          // Create conversation entity so it appears in the sidebar.
          // mergeMAMMessages (triggered by queryArchive's chat:mam-messages event)
          // already stored the messages but couldn't set lastMessage without an existing entity.
          if (result.messages.length > 0 && !this.deps.stores?.chat.hasConversation(contact.jid)) {
            const lastMsg = result.messages[result.messages.length - 1]
            this.deps.emitSDK('chat:conversation', {
              conversation: {
                id: contact.jid,
                name: contact.name || getLocalPart(contact.jid),
                type: 'chat' as const,
                unreadCount: 0,
                lastMessage: lastMsg,
              },
            })
          }
        } catch (_error) {
          // Silently ignore — individual failures shouldn't affect others
        }
      },
      concurrency
    )

    logInfo(`Roster discovery complete for ${newContacts.length} contact(s)`)
  }

  /**
   * Background catch-up for all joined MAM-enabled rooms.
   *
   * After being offline, this fetches the full message history for all rooms
   * so messages are ready when the user opens them.
   *
   * Only processes rooms that are joined, support MAM, and are not Quick Chat rooms.
   * Uses forward queries for efficiency.
   *
   * @param options - Optional configuration
   * @param options.concurrency - Maximum parallel requests (default: 2)
   * @param options.exclude - Room JID to skip (e.g., the active room already handled by side effects)
   */
  async catchUpAllRooms(options: { concurrency?: number; exclude?: string | null } = {}): Promise<void> {
    const { concurrency = 2, exclude } = options
    const joinedRooms = this.deps.stores?.room.joinedRooms() || []

    // Filter for MAM-enabled, non-Quick Chat rooms (and exclude active room if specified)
    const mamRooms = joinedRooms.filter((r) => r.supportsMAM && !r.isQuickChat && (!exclude || r.jid !== exclude))
    if (mamRooms.length === 0) return

    logInfo(`Background catch-up for ${mamRooms.length} room(s)`)

    this.deps.emitSDK('console:event', {
      message: `Background catch-up for ${mamRooms.length} room(s)`,
      category: 'sm',
    })

    await executeWithConcurrency(
      mamRooms,
      async (room) => {
        try {
          if (this.deps.stores?.connection.getStatus() !== 'online') return

          // Load IndexedDB cache first so we know the newest cached message
          // and can do a proper forward catch-up instead of fetching only latest.
          // Without this, room.messages is empty after app restart (runtime-only),
          // causing a backward "before:''" query that creates gaps with old cache.
          await this.deps.stores?.room.loadMessagesFromCache(room.jid, { limit: MAM_CACHE_LOAD_LIMIT })

          // Re-read room after cache load (store was mutated)
          const updatedRoom = this.deps.stores?.room.getRoom(room.jid)
          const messages = updatedRoom?.messages || []
          const newestMessage = findNewestMessage(messages)

          if (newestMessage?.timestamp) {
            // Forward query from the last known message
            await this.queryRoomArchive({
              roomJid: room.jid,
              start: buildCatchUpStartTime(newestMessage.timestamp),
              max: MAM_CATCHUP_FORWARD_MAX,
            })
          } else {
            // No messages (empty) — fetch latest from MAM
            await this.queryRoomArchive({
              roomJid: room.jid,
              before: '',
              max: MAM_CATCHUP_BACKWARD_MAX,
            })
          }
        } catch (_error) {
          // Silently ignore — individual failures shouldn't affect others
        }
      },
      concurrency
    )

    logInfo(`Background catch-up for ${mamRooms.length} room(s) — complete`)
  }

  /**
   * Force a full MAM catch-up for all joined rooms over a given time window.
   *
   * Unlike `catchUpAllRooms()` which starts from the newest cached message,
   * this method queries from a fixed start date (default: 7 days ago) to
   * fill any gaps left by previous incomplete catch-ups. The store's merge
   * logic deduplicates messages that already exist.
   *
   * Intended for manual use via a UI action (e.g., sidebar menu item).
   *
   * @param options.days - Number of days to catch up (default: 7)
   * @param options.concurrency - Max concurrent MAM queries (default: 2)
   */
  async forceCatchUpAllRooms(options: { days?: number; concurrency?: number } = {}): Promise<void> {
    const { days = 7, concurrency = 2 } = options
    const joinedRooms = this.deps.stores?.room.joinedRooms() || []
    const mamRooms = joinedRooms.filter((r) => r.supportsMAM && !r.isQuickChat)
    if (mamRooms.length === 0) return

    const start = new Date(Date.now() - days * 86_400_000).toISOString()

    logInfo(`Force catch-up for ${mamRooms.length} room(s) from last ${days} days`)
    this.deps.emitSDK('console:event', {
      message: `Force catch-up for ${mamRooms.length} room(s) from last ${days} days`,
      category: 'sm',
    })

    await executeWithConcurrency(
      mamRooms,
      async (room) => {
        try {
          if (this.deps.stores?.connection.getStatus() !== 'online') return

          await this.queryRoomArchive({
            roomJid: room.jid,
            start,
            max: MAM_CATCHUP_FORWARD_MAX,
          })
        } catch (_error) {
          // Silently ignore — individual failures shouldn't affect others
        }
      },
      concurrency
    )

    logInfo(`Force catch-up for ${mamRooms.length} room(s) — complete`)
  }

  /**
   * Fetch the latest message for a single conversation (preview only).
   * Updates lastMessage without affecting message history.
   *
   * @param conversationId - The bare JID of the conversation
   * @param options - Optional behavior overrides
   * @param options.unarchiveIfNewer - If true, unarchive the conversation when a newer incoming message is found
   */
  private async fetchPreviewForConversation(
    conversationId: string,
    options: { unarchiveIfNewer?: boolean } = {}
  ): Promise<void> {
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

      const collectMessage = this.createMessageCollector(queryId, (forwarded, _messageEl, archiveId) => {
        const msg = this.parseArchiveMessage(forwarded, conversationId, archiveId)
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
        // latestMessage is mutated by the collector callback; TS CFA can't track this
        const message = latestMessage as Message | null
        if (response && message) {
          // For archived conversations: check if we should unarchive BEFORE updating preview
          // (updateLastMessagePreview uses shouldUpdateLastMessage internally)
          if (options.unarchiveIfNewer && !message.isOutgoing) {
            const existingLastMessage = this.deps.stores?.chat.getLastMessage?.(conversationId)
            const existingTime = existingLastMessage?.timestamp?.getTime() ?? 0
            const newTime = message.timestamp?.getTime() ?? 0
            if (newTime > existingTime) {
              this.deps.stores?.chat.unarchiveConversation?.(conversationId)
            }
          }

          // Update only the lastMessage preview, not the message history
          this.deps.stores?.chat.updateLastMessagePreview(conversationId, message)
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

      const collectMessage = this.createMessageCollector(queryId, (forwarded, _messageEl, archiveId) => {
        const msg = this.parseRoomArchiveMessage(forwarded, roomJid, myNickname, archiveId)
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
    onMessage: (forwarded: Element, messageEl: Element, archiveId?: string) => void
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

      // The <result id="..."> is the MAM archive ID — stable and unique per message
      onMessage(forwarded, messageEl, result.attrs.id)
    }
  }

  /**
   * Check for and collect modifications (retractions, corrections, fastenings, reactions).
   * Returns true if the message was a modification (not a regular message).
   */
  /**
   * Extract the XEP-0203 delay timestamp from a MAM <forwarded> wrapper.
   * Returns undefined if no delay stamp is present.
   */
  private extractForwardedTimestamp(forwarded: Element): Date | undefined {
    const delayEl = forwarded.getChild('delay', NS_DELAY)
    const stamp = delayEl?.attrs.stamp
    return stamp ? new Date(stamp) : undefined
  }

  private collectModification(
    messageEl: Element,
    modifications: MAMModifications,
    normalizeFrom: (from: string) => string,
    timestamp?: Date
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
        // Capture the correction stanza's own stanza-id so replies referencing
        // the corrected version's archive entry can resolve to the original message
        const correctionStanzaId = parseStanzaId(messageEl)
        modifications.corrections.push({
          targetId: replaceEl.attrs.id,
          from: normalizeFrom(from),
          body: bodyText,
          messageEl,
          correctionStanzaId,
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
        ...(timestamp && { timestamp }),
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
    senderMatches: (msg: T, from: string) => boolean,
    normalizeReactor?: (from: string) => string
  ): UnresolvedModifications {
    const unresolved: UnresolvedModifications = {
      retractions: [],
      corrections: [],
      fastenings: [],
      reactions: [],
    }

    // Apply retractions
    for (const retraction of modifications.retractions) {
      const target = messages.find(m => m.id === retraction.targetId || m.stanzaId === retraction.targetId)
      if (target) {
        const retractionData = applyRetraction(senderMatches(target, retraction.from))
        if (retractionData) {
          target.isRetracted = retractionData.isRetracted
          target.retractedAt = retractionData.retractedAt
        }
      } else {
        unresolved.retractions.push(retraction)
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
        // Track the correction's stanza-id so replies referencing it can resolve
        if (correction.correctionStanzaId) {
          target.correctionStanzaIds = [...(target.correctionStanzaIds ?? []), correction.correctionStanzaId]
        }
      } else if (!target) {
        unresolved.corrections.push(correction)
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
      } else {
        unresolved.fastenings.push(fastening)
      }
    }

    // Apply reactions (XEP-0444)
    // Reactions replace the user's previous reactions on the same message
    for (const reaction of modifications.reactions) {
      const target = messages.find(m => m.id === reaction.targetId || m.stanzaId === reaction.targetId)
      if (target) {
        // Normalize reactor identifier (e.g., extract nick from full MUC JID)
        // to stay consistent with how the store identifies reactors for live reactions
        const reactorId = normalizeReactor ? normalizeReactor(reaction.from) : reaction.from

        // Initialize reactions object if not present
        if (!target.reactions) {
          target.reactions = {}
        }

        // Remove this user from all existing reactions on this message
        for (const emoji of Object.keys(target.reactions)) {
          target.reactions[emoji] = target.reactions[emoji].filter(id => id !== reactorId)
          if (target.reactions[emoji].length === 0) {
            delete target.reactions[emoji]
          }
        }

        // Add the new reactions from this user
        for (const emoji of reaction.emojis) {
          if (!target.reactions[emoji]) {
            target.reactions[emoji] = []
          }
          if (!target.reactions[emoji].includes(reactorId)) {
            target.reactions[emoji].push(reactorId)
          }
        }

        // Clean up empty reactions object
        if (Object.keys(target.reactions).length === 0) {
          target.reactions = undefined
        }
      } else {
        unresolved.reactions.push(reaction)
      }
    }

    return unresolved
  }

  /**
   * Emit unresolved chat modifications as store events.
   * These target messages already in the store (from previous queries or cache).
   */
  private emitUnresolvedChatModifications(
    conversationId: string,
    unresolved: UnresolvedModifications
  ): void {
    for (const retraction of unresolved.retractions) {
      this.deps.emitSDK('chat:message-updated', {
        conversationId,
        messageId: retraction.targetId,
        updates: { isRetracted: true, retractedAt: new Date() },
      })
    }

    for (const correction of unresolved.corrections) {
      // Read the original body from the cached message in the store
      const cachedMessage = this.deps.stores?.chat.getMessage(conversationId, correction.targetId)
      const originalBody = cachedMessage?.originalBody ?? cachedMessage?.body ?? ''
      const correctionData = applyCorrection(correction.messageEl, correction.body, originalBody)
      const existingIds = cachedMessage?.correctionStanzaIds ?? []
      const correctionStanzaIds = correction.correctionStanzaId
        ? [...existingIds, correction.correctionStanzaId]
        : existingIds.length > 0 ? existingIds : undefined
      this.deps.emitSDK('chat:message-updated', {
        conversationId,
        messageId: correction.targetId,
        updates: {
          body: correctionData.body,
          isEdited: correctionData.isEdited,
          originalBody: correctionData.originalBody,
          ...(correctionData.attachment ? { attachment: correctionData.attachment } : {}),
          ...(correctionStanzaIds ? { correctionStanzaIds } : {}),
        },
      })
    }

    for (const fastening of unresolved.fastenings) {
      const linkPreview = parseOgpFastening(fastening.applyToEl)
      if (linkPreview) {
        this.deps.emitSDK('chat:message-updated', {
          conversationId,
          messageId: fastening.targetId,
          updates: { linkPreview },
        })
      }
    }

    for (const reaction of unresolved.reactions) {
      this.deps.emitSDK('chat:reactions', {
        conversationId,
        messageId: reaction.targetId,
        reactorJid: reaction.from,
        emojis: reaction.emojis,
        ...(reaction.timestamp && { timestamp: reaction.timestamp }),
      })
    }
  }

  /**
   * Emit unresolved room modifications as store events.
   * These target messages already in the store (from previous queries or cache).
   */
  private emitUnresolvedRoomModifications(
    roomJid: string,
    unresolved: UnresolvedModifications
  ): void {
    for (const retraction of unresolved.retractions) {
      this.deps.emitSDK('room:message-updated', {
        roomJid,
        messageId: retraction.targetId,
        updates: { isRetracted: true, retractedAt: new Date() },
      })
    }

    for (const correction of unresolved.corrections) {
      // Read the original body from the cached message in the store
      const cachedMessage = this.deps.stores?.room.getMessage(roomJid, correction.targetId)
      const originalBody = cachedMessage?.originalBody ?? cachedMessage?.body ?? ''
      const correctionData = applyCorrection(correction.messageEl, correction.body, originalBody)
      // Accumulate correction stanza-ids for reply lookup
      const existingIds = cachedMessage?.correctionStanzaIds ?? []
      const correctionStanzaIds = correction.correctionStanzaId
        ? [...existingIds, correction.correctionStanzaId]
        : existingIds.length > 0 ? existingIds : undefined
      this.deps.emitSDK('room:message-updated', {
        roomJid,
        messageId: correction.targetId,
        updates: {
          body: correctionData.body,
          isEdited: correctionData.isEdited,
          originalBody: correctionData.originalBody,
          ...(correctionData.attachment ? { attachment: correctionData.attachment } : {}),
          ...(correctionStanzaIds ? { correctionStanzaIds } : {}),
        },
      })
    }

    for (const fastening of unresolved.fastenings) {
      const linkPreview = parseOgpFastening(fastening.applyToEl)
      if (linkPreview) {
        this.deps.emitSDK('room:message-updated', {
          roomJid,
          messageId: fastening.targetId,
          updates: { linkPreview },
        })
      }
    }

    for (const reaction of unresolved.reactions) {
      this.deps.emitSDK('room:reactions', {
        roomJid,
        messageId: reaction.targetId,
        reactorNick: getResource(reaction.from) || reaction.from,
        emojis: reaction.emojis,
        ...(reaction.timestamp && { timestamp: reaction.timestamp }),
      })
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
  private parseArchiveMessage(forwarded: Element, conversationId: string, archiveId?: string): Message | null {
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

    // Use stanza-id from message element, or fall back to MAM archive ID (they're equivalent)
    const stanzaId = parsed.stanzaId || archiveId

    // For message ID: prefer message id attr, then generate stable ID from content
    const messageId = messageEl.attrs.id || generateStableMessageId(from, parsed.timestamp, body || '')

    return {
      type: 'chat',
      id: messageId,
      ...(stanzaId && { stanzaId }),
      ...(parsed.originId && { originId: parsed.originId }),
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
  private parseRoomArchiveMessage(forwarded: Element, roomJid: string, myNickname: string, archiveId?: string): RoomMessage | null {
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

    // Accept messages with body, OOB attachment, or poll elements
    if (!from) return null
    const hasPoll = !!messageEl.getChild('poll', NS_POLL)
    const hasPollClosed = !!messageEl.getChild('poll-closed', NS_POLL)
    if (!body && !messageEl.getChild('x', NS_OOB) && !hasPoll && !hasPollClosed) return null

    const nick = getResource(from) || ''
    // Case-insensitive nickname comparison - some servers may change case
    const isOutgoing = nick.toLowerCase() === myNickname.toLowerCase()
    const parsed = parseMessageContent({ messageEl, body: body || '', delayEl, forceDelayed: true, preserveFullReplyToJid: true, messageContext: 'room' })

    // Use stanza-id from message element, or fall back to MAM archive ID (they're equivalent)
    const stanzaId = parsed.stanzaId || archiveId

    // For message ID: prefer message id attr, then generate stable ID from content
    const messageId = messageEl.attrs.id || generateStableMessageId(from, parsed.timestamp, body || '')

    // XEP-0421: Anonymous Unique Occupant Identifiers
    const occupantId = messageEl.getChild('occupant-id', NS_OCCUPANT_ID)?.attrs.id

    const message: RoomMessage = {
      type: 'groupchat',
      id: messageId,
      ...(stanzaId && { stanzaId }),
      ...(parsed.originId && { originId: parsed.originId }),
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
      ...(occupantId && { occupantId }),
    }

    // Poll detection: parse <poll> or <poll-closed> elements from archived messages
    if (hasPoll) {
      const pollData = parsePollElement(messageEl.getChild('poll', NS_POLL)!)
      if (pollData) {
        message.poll = pollData
        if (occupantId) message.poll.creatorId = occupantId
      }
    }
    if (hasPollClosed) {
      const pollClosedData = parsePollClosedElement(messageEl.getChild('poll-closed', NS_POLL)!)
      if (pollClosedData) {
        message.pollClosed = pollClosedData
      }
    }
    return message
  }

  /**
   * Fetch a single room message by its ID using MAM.
   *
   * Checks the store first (by both client ID and stanza-id).
   * If not found, queries MAM using the `{urn:xmpp:mam:2}ids` form field.
   *
   * @param roomJid - The room JID
   * @param messageId - The message ID (client ID or stanza-id / archive ID)
   * @returns The message if found, or null
   */
  async fetchRoomMessageById(roomJid: string, messageId: string): Promise<RoomMessage | null> {
    // Check store first — getMessage checks both id and stanzaId
    const existing = this.deps.stores?.room.getMessage(roomJid, messageId)
    if (existing) return existing

    const room = this.deps.stores?.room.getRoom(roomJid)
    const myNickname = room?.nickname || ''
    const queryId = `mam_${generateUUID()}`

    const formFields: Element[] = [
      xml('field', { var: 'FORM_TYPE', type: 'hidden' }, xml('value', {}, NS_MAM)),
      xml('field', { var: '{urn:xmpp:mam:2}ids' }, xml('value', {}, messageId)),
    ]

    const iq = this.buildMAMQuery(queryId, formFields, 1, undefined, roomJid)

    let result: RoomMessage | null = null
    const collectMessage = this.createMessageCollector(queryId, (forwarded, _messageEl, archiveId) => {
      const msg = this.parseRoomArchiveMessage(forwarded, roomJid, myNickname, archiveId)
      if (msg) result = msg
    })

    let unregister: () => void
    if (this.deps.registerMAMCollector) {
      unregister = this.deps.registerMAMCollector(queryId, collectMessage)
    } else {
      const xmpp = this.deps.getXmpp()
      xmpp?.on('stanza', collectMessage)
      unregister = () => xmpp?.removeListener('stanza', collectMessage)
    }

    try {
      await this.deps.sendIQ(iq)
    } catch {
      // MAM query failed — server may not support {ids} filter
      return null
    } finally {
      unregister!()
    }

    // If found, add to the store so subsequent lookups don't need MAM
    if (result) {
      this.deps.emitSDK('room:message', {
        roomJid,
        message: result,
        incrementUnread: false,
        incrementMentions: false,
      })
    }

    return result
  }
}
