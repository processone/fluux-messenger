/**
 * Search store for managing full-text search state.
 *
 * Ephemeral state — no persistence. Coordinates search queries
 * against the local search index and optionally against server MAM archives.
 *
 * Local results appear instantly (debounced 300ms). MAM search is triggered
 * on demand via `searchMAM()` and results are shown separately below local
 * results, deduplicated to avoid showing messages already found locally.
 *
 * @module SearchStore
 */

import { createStore } from 'zustand/vanilla'
import * as searchIndex from '../utils/searchIndex'
import { parseSearchQuery } from '../utils/searchIndex'
import { generateMatchSnippet, type MatchSnippet } from '../utils/searchUtils'
import { chatStore } from './chatStore'
import { roomStore } from './roomStore'
import { connectionStore } from './connectionStore'
import { areRetractedInCache, getMessages, getRoomMessages } from '../utils/messageCache'
import type { XMPPClient } from '../core/XMPPClient'
import type { Message, RoomMessage } from '../core/types'
import { applyPendingRetractions } from './shared/pendingRetractions'
import { getCorrectionStanzaIds } from '../core/types/message-internal'
import {
  CHAT_SCOPE,
  chatMessageAuthor,
  identityProbes,
  mergeableOccupantCandidates,
  messageReferences,
  resolveMessageReference,
  roomScope,
  roomMessageAuthor,
  sameLogicalMessage,
} from '../utils/messageIdentity'

/**
 * Filter type for narrowing search results by conversation type.
 */
export type SearchFilterType = 'all' | 'conversations' | 'rooms'

/**
 * Autocomplete suggestion for the `in:` prefix.
 */
export interface InPrefixSuggestion {
  /** Conversation or room JID */
  id: string
  /** Display name */
  name: string
  /** Whether this is a room (groupchat) */
  isRoom: boolean
}

/**
 * A search result enriched with conversation context and match snippet.
 */
export interface SearchResult {
  /** The index ID (used for deduplication) */
  indexId: string
  /** Client-generated message ID (matches data-message-id in DOM) */
  messageId: string
  /** The conversation or room JID */
  conversationId: string
  /** Display name of the conversation or room */
  conversationName: string
  /** Whether this result is from a room (groupchat) */
  isRoom: boolean
  /** Sender JID or nick */
  from: string
  /** Sender nickname (room messages only) */
  nick?: string
  /** Message timestamp */
  timestamp: number
  /** Original message body */
  body: string
  /** Highlighted match snippet for display */
  matchSnippet: MatchSnippet | null
  /** Where this result was found */
  source: 'local' | 'mam'
  /**
   * XEP-0359 archive id, when the result carries one. Optional because a local
   * result projected from an un-archived message has none.
   */
  stanzaId?: string
  /** XEP-0359 sender-assigned origin id, when the result carries one. */
  originId?: string
  /** XEP-0421 occupant id (room results only), when the room stamps them. */
  occupantId?: string
}

/**
 * Lightweight context message for display in search result previews.
 */
export interface ContextMessage {
  body: string
  nick?: string
  from: string
  timestamp: number
  /**
   * Whether the message has been retracted. Retracted messages keep their
   * `body` in the cache so the bubble can be replaced in place, so a consumer
   * that renders `body` blindly would show text the sender deleted. Context
   * lines must substitute a localized "message deleted" notice instead.
   */
  isRetracted?: boolean
}

/**
 * Context messages surrounding a search result (before and after).
 */
export interface SearchResultContext {
  before: ContextMessage[]
  after: ContextMessage[]
}

export interface SearchState {
  /** Current search query */
  query: string
  /** Whether a local search is in progress */
  isSearching: boolean
  /** Local search results sorted by recency */
  results: SearchResult[]
  /** Error message if search failed */
  error: string | null
  /** Search result currently being previewed in the context view */
  previewResult: SearchResult | null

  /** Whether a MAM search is in progress */
  isSearchingMAM: boolean
  /** MAM search results (excludes duplicates already in local results) */
  mamResults: SearchResult[]
  /** Whether more MAM results are available (for pagination) */
  hasMoreMAMResults: boolean
  /** Error message if MAM search failed */
  mamError: string | null

  /** Context messages around search results (keyed by indexId) */
  resultContext: Map<string, SearchResultContext>

  /** Conversation scope: null = global, JID = conversation-scoped */
  searchScope: string | null

  /** Filter by conversation type */
  searchFilter: SearchFilterType

  /** Autocomplete suggestions for `in:` prefix */
  inPrefixSuggestions: InPrefixSuggestion[]
  /** Whether the `in:` autocomplete is active */
  isInPrefixActive: boolean

  /** Execute a local search (debounced internally) */
  search: (query: string) => void
  /** Clear all search state */
  clearSearch: () => void
  /** Set the search result to preview in context */
  setPreviewResult: (result: SearchResult | null) => void
  /** Trigger MAM search for the current query */
  searchMAM: () => void
  /** Load more MAM results (pagination) */
  loadMoreMAMResults: () => void
  /** Set conversation scope for search */
  setSearchScope: (conversationId: string | null) => void
  /** Set search filter type */
  setSearchFilter: (filter: SearchFilterType) => void
  /** Select an `in:` prefix suggestion to scope the search */
  selectInPrefixSuggestion: (suggestion: InPrefixSuggestion) => void
}

// --- Module-level state ---

/** Debounce timer for search input */
let debounceTimer: ReturnType<typeof setTimeout> | null = null
const DEBOUNCE_MS = 300

/** Client reference for MAM queries (set by provider, not in store state) */
let clientRef: XMPPClient | null = null

/** Generation counter for cancelling stale MAM searches */
let mamSearchGeneration = 0

/** RSM cursor for MAM pagination */
let mamRsmCursor: string | undefined

/** AbortController for paging search */
let pagingAbortController: AbortController | null = null

/**
 * Set the XMPPClient reference used for MAM search queries.
 * Called by XMPPProvider on client creation.
 */
export function setSearchClient(client: XMPPClient | null): void {
  clientRef = client
}

/**
 * Get the XMPPClient reference for MAM operations.
 * Used by SearchContextView for context fetching and catch-up.
 */
export function getSearchClient(): XMPPClient | null {
  return clientRef
}

/**
 * Resolve a display name for a conversation or room.
 */
function getConversationName(conversationId: string, isRoom: boolean): string {
  if (isRoom) {
    const room = roomStore.getState().rooms.get(conversationId)
    return room?.name || conversationId
  }
  const entity = chatStore.getState().conversationEntities.get(conversationId)
  return entity?.name || conversationId
}

function findResidentChatMessage(msg: Message): Message | undefined {
  const residents = chatStore.getState().messages.get(msg.conversationId) ?? []
  const probes = identityProbes<Message>(msg, 'archive-first')
  const strongProbes = probes.filter(({ tier }) => tier !== 'fallback')
  for (const probe of strongProbes) {
    const resident = residents.find((candidate) => probe.matches(candidate))
    if (resident) return resident
  }
  if (strongProbes.length > 0) return undefined

  const fallback = probes.find(({ tier }) => tier === 'fallback')
  return fallback
    ? residents.find((candidate) =>
      fallback.matches(candidate) && chatMessageAuthor(candidate, { actorJid: msg.from })
    )
    : undefined
}

function isChatRetracted(msg: Message, resident?: Message): boolean {
  const state = chatStore.getState()
  const current = resident ?? findResidentChatMessage(msg) ?? msg
  if (current.isRetracted) return true
  const pending = state.pendingRetractions.get(msg.conversationId) ?? []
  return applyPendingRetractions(
    [current],
    pending,
    chatMessageAuthor
  ).applied.length > 0
}

function findResidentRoomMessage(msg: RoomMessage, roomJid: string): RoomMessage | undefined {
  const sameSender = (roomStore.getState().messages.get(roomJid) ?? [])
    .filter(candidate => candidate.from === msg.from)
  // Identity fields only — never spread `msg`, whose `body` may be a getter the
  // caller must not trigger before the tombstone check.
  const probe = {
    id: msg.id,
    stanzaId: msg.stanzaId,
    originId: msg.originId,
    correctionStanzaIds: getCorrectionStanzaIds(msg),
  }
  for (const reference of messageReferences(probe, 'client-id-first')) {
    const resolution = resolveMessageReference(sameSender, reference, 'client-id-first')
    if (!resolution) continue
    const rawCandidates = resolution.candidates.map(({ message }) => message)
    const candidates = mergeableOccupantCandidates(msg, rawCandidates)
    if (candidates.length === 0) continue
    return candidates.find((candidate) =>
      !!msg.occupantId && candidate.occupantId === msg.occupantId
    ) ?? candidates[0]
  }
  return undefined
}

function isRoomRetracted(msg: RoomMessage, roomJid: string): boolean {
  const state = roomStore.getState()
  const current = findResidentRoomMessage(msg, roomJid) ?? msg
  if (current.isRetracted) return true
  const pending = state.pendingRetractions.get(roomJid) ?? []
  return applyPendingRetractions(
    [current],
    pending,
    roomMessageAuthor
  ).applied.length > 0
}

type SearchMessageCandidate =
  | { kind: 'chat'; message: Message }
  | { kind: 'room'; message: RoomMessage; roomJid: string }

async function classifyRetractedCandidates(candidates: SearchMessageCandidate[]): Promise<boolean[]> {
  const verdicts: Array<boolean | undefined> = new Array(candidates.length)
  const nonresident: Array<{ position: number; candidate: SearchMessageCandidate }> = []

  candidates.forEach((candidate, position) => {
    if (candidate.kind === 'room') {
      const resident = findResidentRoomMessage(candidate.message, candidate.roomJid)
      if (resident) verdicts[position] = isRoomRetracted(resident, candidate.roomJid)
      else nonresident.push({ position, candidate })
    } else {
      const resident = findResidentChatMessage(candidate.message)
      if (resident) verdicts[position] = isChatRetracted(candidate.message, resident)
      else nonresident.push({ position, candidate })
    }
  })

  if (nonresident.length > 0) {
    const cached = await areRetractedInCache(nonresident.map(({ candidate }) => candidate.message))
    nonresident.forEach(({ position, candidate }, index) => {
      verdicts[position] = cached[index] || (
        candidate.kind === 'room'
          ? isRoomRetracted(candidate.message, candidate.roomJid)
          : isChatRetracted(candidate.message)
      )
    })
  }

  return verdicts.map(verdict => verdict ?? false)
}

function indexResultToCandidate(result: searchIndex.SearchIndexResult): SearchMessageCandidate {
  if (result.isRoom) {
    return {
      kind: 'room',
      roomJid: result.conversationId,
      message: {
        id: result.messageId,
        roomJid: result.conversationId,
        from: result.from,
        nick: result.nick ?? '',
        body: result.body,
        timestamp: new Date(result.timestamp),
        isOutgoing: false,
        type: 'groupchat',
        stanzaId: result.stanzaId,
        originId: result.originId,
        occupantId: result.occupantId,
      },
    }
  }
  return {
    kind: 'chat',
    message: {
      id: result.messageId,
      conversationId: result.conversationId,
      from: result.from,
      body: result.body,
      timestamp: new Date(result.timestamp),
      isOutgoing: false,
      type: 'chat',
      stanzaId: result.stanzaId,
      originId: result.originId,
    },
  }
}

/**
 * Convert a Message to a SearchResult.
 */
function messageToSearchResult(msg: Message, query: string, phrases?: string[]): SearchResult | null {
  if (isChatRetracted(msg)) return null
  return {
    indexId: `mam:chat:${msg.id}`,
    messageId: msg.id,
    stanzaId: msg.stanzaId,
    originId: msg.originId,
    conversationId: msg.conversationId,
    conversationName: getConversationName(msg.conversationId, false),
    isRoom: false,
    from: msg.from,
    timestamp: msg.timestamp.getTime(),
    body: msg.body || '',
    matchSnippet: generateMatchSnippet(msg.body || '', query, 60, phrases),
    source: 'mam',
  }
}

/**
 * Convert a RoomMessage to a SearchResult.
 */
function roomMessageToSearchResult(msg: RoomMessage, roomJid: string, query: string, phrases?: string[]): SearchResult | null {
  if (isRoomRetracted(msg, roomJid)) return null
  return {
    indexId: `mam:room:${msg.id}`,
    messageId: msg.id,
    stanzaId: msg.stanzaId,
    originId: msg.originId,
    occupantId: msg.occupantId,
    conversationId: roomJid,
    conversationName: getConversationName(roomJid, true),
    isRoom: true,
    from: msg.from,
    nick: msg.nick,
    timestamp: msg.timestamp.getTime(),
    body: msg.body || '',
    matchSnippet: generateMatchSnippet(msg.body || '', query, 60, phrases),
    source: 'mam',
  }
}

async function messagesToSearchResults(
  messages: Message[],
  query: string,
  phrases?: string[]
): Promise<SearchResult[]> {
  const retracted = await classifyRetractedCandidates(messages.map(message => ({ kind: 'chat' as const, message })))
  return messages.flatMap((message, index) => {
    if (retracted[index]) return []
    const result = messageToSearchResult(message, query, phrases)
    return result ? [result] : []
  })
}

async function roomMessagesToSearchResults(
  messages: RoomMessage[],
  roomJid: string,
  query: string,
  phrases?: string[]
): Promise<SearchResult[]> {
  const retracted = await classifyRetractedCandidates(messages.map(message => ({ kind: 'room' as const, message, roomJid })))
  return messages.flatMap((message, index) => {
    if (retracted[index]) return []
    const result = roomMessageToSearchResult(message, roomJid, query, phrases)
    return result ? [result] : []
  })
}

/**
 * Deduplicate MAM results against local results.
 * Returns only MAM results whose messageId is not in the local results set.
 */
export function deduplicateMAMResults(
  localResults: SearchResult[],
  mamResults: SearchResult[]
): SearchResult[] {
  if (localResults.length === 0) return mamResults
  // Pre-index the local results by conversation. Comparing every MAM result
  // against every local one is quadratic, and each comparison allocates the
  // identity keys it compares; results within one conversation are the only
  // candidates for a match, so this keeps the common case near-linear.
  const localByConversation = new Map<string, SearchResult[]>()
  for (const local of localResults) {
    const bucket = localByConversation.get(local.conversationId)
    if (bucket) bucket.push(local)
    else localByConversation.set(local.conversationId, [local])
  }
  return mamResults.filter(mam => {
    const candidates = localByConversation.get(mam.conversationId)
    return !candidates?.some(local => sameSearchResult(local, mam))
  })
}

function searchResultIdentity(result: SearchResult) {
  return {
    id: result.messageId,
    from: result.from,
    stanzaId: result.stanzaId,
    originId: result.originId,
    occupantId: result.occupantId,
    ...(result.isRoom ? { roomJid: result.conversationId } : {}),
  }
}

function sameSearchResult(a: SearchResult, b: SearchResult): boolean {
  if (a.isRoom !== b.isRoom || a.conversationId !== b.conversationId) return false
  const scope = a.isRoom ? roomScope(a.conversationId) : CHAT_SCOPE
  return sameLogicalMessage(scope, searchResultIdentity(a), searchResultIdentity(b))
}

function sameSearchResultMessage(result: SearchResult, message: Message | RoomMessage): boolean {
  if (result.isRoom) {
    if (message.type !== 'groupchat' || message.roomJid !== result.conversationId) return false
    return sameLogicalMessage(roomScope(result.conversationId), searchResultIdentity(result), message)
  }
  if (message.type !== 'chat' || message.conversationId !== result.conversationId) return false
  return sameLogicalMessage(CHAT_SCOPE, searchResultIdentity(result), message)
}

/**
 * Fetch context messages (1 before, 1 after) for local search results.
 * Called after results are set — updates resultContext asynchronously.
 */
async function fetchResultContexts(results: SearchResult[], query: string): Promise<void> {
  const localResults = results.filter(r => r.source === 'local')
  if (localResults.length === 0) return

  const contextMap = new Map<string, SearchResultContext>()

  await Promise.all(
    localResults.map(async (result) => {
      try {
        const ts = new Date(result.timestamp)

        let before: ContextMessage[] = []
        let after: ContextMessage[] = []

        if (result.isRoom) {
          const [beforeMsgs, afterMsgs] = await Promise.all([
            getRoomMessages(result.conversationId, { before: ts, limit: 1 }),
            getRoomMessages(result.conversationId, { after: ts, limit: 2 }),
          ])
          before = beforeMsgs
            .filter(m => !sameSearchResultMessage(result, m))
            .map(m => ({ body: m.body || '', nick: m.nick, from: m.from, timestamp: m.timestamp.getTime(), isRetracted: isRoomRetracted(m, result.conversationId) }))
          after = afterMsgs
            .filter(m => !sameSearchResultMessage(result, m))
            .slice(0, 1)
            .map(m => ({ body: m.body || '', nick: m.nick, from: m.from, timestamp: m.timestamp.getTime(), isRetracted: isRoomRetracted(m, result.conversationId) }))
        } else {
          const [beforeMsgs, afterMsgs] = await Promise.all([
            getMessages(result.conversationId, { before: ts, limit: 1 }),
            getMessages(result.conversationId, { after: ts, limit: 2 }),
          ])
          before = beforeMsgs
            .filter(m => !sameSearchResultMessage(result, m))
            .map(m => ({ body: m.body || '', from: m.from, timestamp: m.timestamp.getTime(), isRetracted: isChatRetracted(m) }))
          after = afterMsgs
            .filter(m => !sameSearchResultMessage(result, m))
            .slice(0, 1)
            .map(m => ({ body: m.body || '', from: m.from, timestamp: m.timestamp.getTime(), isRetracted: isChatRetracted(m) }))
        }

        if (before.length > 0 || after.length > 0) {
          contextMap.set(result.indexId, { before, after })
        }
      } catch {
        // Skip context for this result on error
      }
    })
  )

  // Guard against stale query
  if (searchStore.getState().query.trim() === query && contextMap.size > 0) {
    searchStore.setState({ resultContext: contextMap })
  }
}

/**
 * Parse a query for an `in:` prefix used to scope search to a conversation.
 *
 * @example
 * parseInPrefix('in:alice')       // { inTerm: 'alice', rest: '' }
 * parseInPrefix('in:Alice hello') // { inTerm: 'Alice', rest: 'hello' }
 * parseInPrefix('hello')          // null
 */
export function parseInPrefix(query: string): { inTerm: string; rest: string } | null {
  const match = query.match(/^in:(\S*)(?:\s(.*))?$/)
  if (!match) return null
  return {
    inTerm: match[1] || '',
    rest: (match[2] || '').trim(),
  }
}

/**
 * Generate autocomplete suggestions for the `in:` prefix by searching
 * conversation entities and rooms by name or JID.
 */
export function getInPrefixSuggestions(term: string): InPrefixSuggestion[] {
  if (!term) return []
  const lowerTerm = term.toLowerCase()
  const results: InPrefixSuggestion[] = []

  // Search 1:1 conversations
  for (const [jid, entity] of chatStore.getState().conversationEntities) {
    if (entity.name.toLowerCase().includes(lowerTerm) || jid.toLowerCase().includes(lowerTerm)) {
      results.push({ id: jid, name: entity.name, isRoom: false })
    }
  }

  // Search rooms
  for (const [jid, room] of roomStore.getState().rooms) {
    const roomName = room.name || jid
    if (roomName.toLowerCase().includes(lowerTerm) || jid.toLowerCase().includes(lowerTerm)) {
      results.push({ id: jid, name: roomName, isRoom: true })
    }
  }

  return results.slice(0, 10)
}

/**
 * Perform the actual local search and update the store.
 */
async function executeSearch(query: string): Promise<void> {
  const state = searchStore.getState()
  const scope = state.searchScope
  const filter = state.searchFilter
  const parsed = parseSearchQuery(query)
  const phrases = parsed.phrases.length > 0 ? parsed.phrases : undefined
  try {
    const indexResults = await searchIndex.search(query, {
      limit: 50,
      ...(scope ? { conversationId: scope } : {}),
      ...(filter === 'conversations' ? { isRoom: false } : {}),
      ...(filter === 'rooms' ? { isRoom: true } : {}),
    })

    const retracted = await classifyRetractedCandidates(indexResults.map(indexResultToCandidate))
    const projected = indexResults.map((r, index): SearchResult | null => {
      if (retracted[index]) return null
      return {
        indexId: r.indexId,
        messageId: r.messageId,
        conversationId: r.conversationId,
        conversationName: getConversationName(r.conversationId, r.isRoom),
        isRoom: r.isRoom,
        from: r.from,
        nick: r.nick,
        timestamp: r.timestamp,
        body: r.body,
        ...(r.stanzaId ? { stanzaId: r.stanzaId } : {}),
        ...(r.originId ? { originId: r.originId } : {}),
        ...(r.occupantId ? { occupantId: r.occupantId } : {}),
        matchSnippet: generateMatchSnippet(r.body, query, 60, phrases),
        source: 'local' as const,
      }
    })
    const results = projected.filter((result): result is SearchResult => result !== null)

    // Only update if the query hasn't changed while we were searching
    const current = searchStore.getState()
    if (current.query === query) {
      // A no-match query maps to a fresh empty array; keeping the previous (also
      // empty) one avoids invalidating useSearch for a result set that did not change.
      const nextResults = results.length === 0 && current.results.length === 0 ? current.results : results
      searchStore.setState({ results: nextResults, isSearching: false, error: null })
      // Fire-and-forget: load context messages for results
      void fetchResultContexts(results, query)
    }
  } catch (err) {
    if (searchStore.getState().query === query) {
      searchStore.setState({
        isSearching: false,
        error: err instanceof Error ? err.message : 'Search failed',
      })
    }
  }
}

/**
 * Execute MAM search based on current state.
 */
async function executeMAMSearch(append: boolean): Promise<void> {
  const state = searchStore.getState()
  const query = state.query
  if (!query || !clientRef) return

  const generation = ++mamSearchGeneration
  const scope = state.searchScope
  const supportsFulltext = connectionStore.getState().mamFulltextSearch
  const parsed = parseSearchQuery(query)
  const phrases = parsed.phrases.length > 0 ? parsed.phrases : undefined

  // Cancel any ongoing paging search
  if (pagingAbortController) {
    pagingAbortController.abort()
    pagingAbortController = null
  }

  searchStore.setState({
    isSearchingMAM: true,
    mamError: null,
    ...(append ? {} : { mamResults: [] }),
  })

  try {
    let newResults: SearchResult[] = []
    let hasMore = false

    if (scope) {
      // Conversation-scoped search
      const isRoom = roomStore.getState().rooms.has(scope)

      if (supportsFulltext) {
        // Server fulltext search scoped to conversation
        if (isRoom) {
          const result = await clientRef.messages.searchRoomMessages({
            query,
            roomJid: scope,
            max: 20,
            before: append ? mamRsmCursor : undefined,
          })
          newResults = await roomMessagesToSearchResults(result.messages, scope, query, phrases)
          hasMore = !result.complete
          mamRsmCursor = result.page.first
        } else {
          const result = await clientRef.messages.searchMessages({
            query,
            with: scope,
            max: 20,
            before: append ? mamRsmCursor : undefined,
          })
          newResults = await messagesToSearchResults(result.messages, query, phrases)
          hasMore = !result.complete
          mamRsmCursor = result.page.first
        }
      } else if (!isRoom) {
        // Paging search (1:1 conversations only, no fulltext required)
        pagingAbortController = new AbortController()
        const result = await clientRef.messages.searchConversationHistory(
          { query, with: scope, maxPages: 20, maxResults: 50 },
          pagingAbortController.signal
        )
        pagingAbortController = null
        newResults = await messagesToSearchResults(result.messages, query, phrases)
        hasMore = !result.complete
      } else {
        // Room paging search not supported — too complex without fulltext
        searchStore.setState({
          isSearchingMAM: false,
          mamError: 'Server does not support archive search for rooms',
        })
        return
      }
    } else {
      // Global search — requires fulltext support
      if (!supportsFulltext) {
        searchStore.setState({
          isSearchingMAM: false,
          mamError: 'Server does not support archive search. Try searching within a conversation.',
        })
        return
      }

      const result = await clientRef.messages.searchMessages({
        query,
        max: 20,
        before: append ? mamRsmCursor : undefined,
      })
      newResults = await messagesToSearchResults(result.messages, query, phrases)
      hasMore = !result.complete
      mamRsmCursor = result.page.first
    }

    // Check generation — discard if query changed
    if (generation !== mamSearchGeneration) return

    // Deduplicate against local results
    const localResults = searchStore.getState().results
    let deduplicated = deduplicateMAMResults(localResults, newResults)

    // Apply type filter to MAM results
    const currentFilter = searchStore.getState().searchFilter
    if (currentFilter === 'conversations') {
      deduplicated = deduplicated.filter(r => !r.isRoom)
    } else if (currentFilter === 'rooms') {
      deduplicated = deduplicated.filter(r => r.isRoom)
    }

    // Index fetched messages locally for future searches
    void indexMAMResults(newResults)

    const existingMAM = append ? searchStore.getState().mamResults : []
    searchStore.setState({
      isSearchingMAM: false,
      mamResults: [...existingMAM, ...deduplicated],
      hasMoreMAMResults: hasMore,
      mamError: null,
    })
  } catch (err) {
    if (generation !== mamSearchGeneration) return
    searchStore.setState({
      isSearchingMAM: false,
      mamError: err instanceof Error ? err.message : 'Server search failed',
    })
  }
}

/**
 * Index MAM search results into the local search index for future queries.
 */
async function indexMAMResults(results: SearchResult[]): Promise<void> {
  try {
    // Project each result into the shape the index reads.
    //
    // `type` is the discriminant — the index derives the document's kind, its
    // conversation and its room-only fields from it, so a projection that omits it
    // files a room result as a conversation-less chat document that no room-scoped
    // removal can ever find.
    //
    // The optional identity fields travel too. Without them a room document is
    // ownerless: a retraction verified through the archive id cannot prove it names
    // that document, and its body survives a deletion the user asked for.
    const chatMessages: Message[] = []
    const roomMessages: RoomMessage[] = []

    for (const r of results) {
      const identity = {
        ...(r.stanzaId ? { stanzaId: r.stanzaId } : {}),
        ...(r.originId ? { originId: r.originId } : {}),
      }
      const common = {
        id: r.messageId,
        from: r.from,
        body: r.body,
        timestamp: new Date(r.timestamp),
        isOutgoing: false,
        ...identity,
      }
      if (r.isRoom) {
        roomMessages.push({
          ...common,
          type: 'groupchat',
          roomJid: r.conversationId,
          nick: r.nick ?? '',
          ...(r.occupantId ? { occupantId: r.occupantId } : {}),
        })
      } else {
        chatMessages.push({
          ...common,
          type: 'chat',
          conversationId: r.conversationId,
        })
      }
    }

    // Index using the same search index used for local messages.
    if (chatMessages.length > 0) {
      await searchIndex.indexMessages(chatMessages)
    }
    if (roomMessages.length > 0) {
      await searchIndex.indexMessages(roomMessages)
    }
  } catch {
    // Silently ignore indexing errors — non-critical
  }
}

export const searchStore = createStore<SearchState>((set, get) => ({
  query: '',
  isSearching: false,
  results: [],
  error: null,
  previewResult: null,
  isSearchingMAM: false,
  mamResults: [],
  hasMoreMAMResults: false,
  mamError: null,
  resultContext: new Map(),
  searchScope: null,
  searchFilter: 'all',
  inPrefixSuggestions: [],
  isInPrefixActive: false,

  search: (query: string) => {
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }

    const trimmed = query.trim()
    if (!trimmed) {
      set({ query: '', isSearching: false, results: [], error: null, mamResults: [], mamError: null, hasMoreMAMResults: false, searchFilter: 'all', inPrefixSuggestions: [], isInPrefixActive: false })
      mamSearchGeneration++  // Cancel any in-flight MAM search
      return
    }

    // Check for in: prefix
    const inParsed = parseInPrefix(trimmed)
    if (inParsed && !inParsed.rest) {
      // User is still typing the in: scope — show suggestions, don't search
      const suggestions = getInPrefixSuggestions(inParsed.inTerm)
      set({
        query,
        isSearching: false,
        results: [],
        inPrefixSuggestions: suggestions,
        isInPrefixActive: true,
      })
      return
    }

    // One write per keystroke. Every `set` notifies subscribers and re-renders the
    // search UI, so the in: reset and the query update go out together rather than as
    // two back-to-back writes. The collections here are only ever *cleared*, and
    // re-allocating one that is already empty would change its identity for no change
    // in value — that defeats the useShallow comparison in useSearch and costs a render
    // on every keystroke. Clear only what actually holds something.
    const prev = get()
    const patch: Partial<SearchState> = {
      query,
      isSearching: true,
      error: null,
      mamError: null,
      hasMoreMAMResults: false,
    }
    if (prev.isInPrefixActive) patch.isInPrefixActive = false
    if (prev.inPrefixSuggestions.length > 0) patch.inPrefixSuggestions = []
    if (prev.mamResults.length > 0) patch.mamResults = []
    if (prev.resultContext.size > 0) patch.resultContext = new Map()
    set(patch)
    mamSearchGeneration++  // Cancel any in-flight MAM search
    mamRsmCursor = undefined

    debounceTimer = setTimeout(() => {
      debounceTimer = null
      void executeSearch(trimmed)
    }, DEBOUNCE_MS)
  },

  clearSearch: () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
    mamSearchGeneration++
    mamRsmCursor = undefined
    if (pagingAbortController) {
      pagingAbortController.abort()
      pagingAbortController = null
    }
    set({
      query: '',
      isSearching: false,
      results: [],
      error: null,
      previewResult: null,
      isSearchingMAM: false,
      mamResults: [],
      hasMoreMAMResults: false,
      mamError: null,
      resultContext: new Map(),
      searchFilter: 'all',
      inPrefixSuggestions: [],
      isInPrefixActive: false,
    })
  },

  setPreviewResult: (result: SearchResult | null) => {
    set({ previewResult: result })
  },

  searchMAM: () => {
    void executeMAMSearch(false)
  },

  loadMoreMAMResults: () => {
    void executeMAMSearch(true)
  },

  setSearchScope: (conversationId: string | null) => {
    const state = searchStore.getState()
    set({
      searchScope: conversationId,
      results: [],
      mamResults: [],
      mamError: null,
      hasMoreMAMResults: false,
    })
    mamSearchGeneration++
    mamRsmCursor = undefined
    // Re-run local search with new scope if there's an active query
    if (state.query) {
      set({ isSearching: true })
      void executeSearch(state.query)
    }
  },

  setSearchFilter: (filter: SearchFilterType) => {
    const state = searchStore.getState()
    set({
      searchFilter: filter,
      results: [],
      mamResults: [],
      mamError: null,
      hasMoreMAMResults: false,
    })
    mamSearchGeneration++
    mamRsmCursor = undefined
    // Re-run local search with new filter if there's an active query
    if (state.query.trim()) {
      set({ isSearching: true })
      void executeSearch(state.query.trim())
    }
  },

  selectInPrefixSuggestion: (suggestion: InPrefixSuggestion) => {
    const state = searchStore.getState()
    const inParsed = parseInPrefix(state.query.trim())
    const restQuery = inParsed?.rest || ''

    // Set scope via existing mechanism
    set({
      searchScope: suggestion.id,
      query: restQuery,
      inPrefixSuggestions: [],
      isInPrefixActive: false,
      results: [],
      mamResults: [],
      mamError: null,
      hasMoreMAMResults: false,
    })
    mamSearchGeneration++
    mamRsmCursor = undefined

    // If there's remaining query text, trigger search
    if (restQuery.trim()) {
      set({ isSearching: true })
      void executeSearch(restQuery.trim())
    }
  },
}))
