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

import { captureStorageScope } from '../utils/storageScope'
import { createStore } from 'zustand/vanilla'
import * as searchIndex from '../utils/searchIndex'
import { parseSearchQuery } from '../utils/searchIndex'
import { filterToken, parseRoomSender, matchesFilterTokens, parseSearchFilters, type ParsedSearchInput } from '../utils/searchFilters'
import { generateMatchSnippet, type MatchSnippet } from '../utils/searchUtils'
import { chatStore } from './chatStore'
import { roomStore } from './roomStore'
import { connectionStore } from './connectionStore'
import { areRetractedInCache, getMessages } from '../utils/messageCache'
import type { XMPPClient } from '../core/XMPPClient'
import type { Message, RoomMessage } from '../core/types'
import { moderationMetadata, roomRetractionAuthorized } from '../utils/moderation'
import { roomStanzaIdsMergeable } from '../utils/roomStanzaId'
import { reconcileRoomMessageSnapshots } from '../utils/roomMessageSnapshots'
import { applyPendingRetractions } from './shared/pendingRetractions'
import {
  CHAT_SCOPE,
  archiveIdentityConflict,
  canonicalKey,
  type RoomIdentityFields,
  chatMessageAuthor,
  identityProbes,
  mergeableOccupantCandidates,
  roomScope,
  selectRoomMergeTargets,
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
  /**
   * Opaque key for result list/context state, not a client message ID. It can
   * change when archive identity arrives. It may contain NUL separators; encode
   * it consistently (e.g. encodeURIComponent) for DOM attributes and their lookups.
   */
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
  /** Whether the message reached the client delayed (XEP-0203): an archive or history copy. */
  isDelayed?: boolean
  /** Whether the message is the user's own. */
  isOutgoing?: boolean
  /** The instant a room copy reached the client (epoch ms), when the row recorded one. */
  receivedAt?: number
  /** Display rows omit attachment and privacy metadata that indexing must preserve. */
  canonicalMessage?: Message | RoomMessage
}

/**
 * Lightweight context message for display in search result previews.
 */
export interface ContextMessage {
  roomMessage?: RoomMessage
  isModerated?: boolean
  moderatedBy?: string
  moderationReason?: string
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
  /** Picked filters stay separate so the text field never needs encoded room identities. */
  pickedFilters: string[]
  setPickedFilters: (filters: string[]) => void
  filtersIncomplete: boolean
  filtersUnavailable: string | null
  retryFilters: () => void
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
  mamSearched: boolean
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
  /**
   * Whether the query uses `from:`, `is:` or `has:` while this device is still
   * giving its stored messages their filter tokens: the results would be partial,
   * so none are shown until it is done. Missing content metadata remains explicitly incomplete.
   */
  filtersBuilding: boolean

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

function supersedeArchiveSearch(): number {
  const controller = pagingAbortController
  pagingAbortController = null
  // Invalidate before aborting: abort listeners may observe or replace the active search.
  const generation = ++mamSearchGeneration
  controller?.abort()
  return generation
}

/** Locale numeric dates in the query are read in (`05/03/2024`); the runtime's when unset. */
let searchLocale: string | undefined

/**
 * Set the locale whose numeric date order `after:`, `before:` and `on:` read,
 * normally the interface language. ISO dates (`2024-03-05`) read the same everywhere.
 */
export function setSearchLocale(locale: string | undefined): void {
  searchLocale = locale
}

/** The query split into its words and its operators, in the reader's locale. */
function parseSearchInput(query: string, picked: readonly string[] = []): ParsedSearchInput {
  return parseSearchFilters(query, searchLocale, picked)
}

function invalidInput(input: ParsedSearchInput): boolean {
  return input.filters.some(filter => !filter.valid) ||
    (input.after !== undefined && input.before !== undefined && input.after >= input.before)
}

function searchSnapshot() {
  const state = searchStore.getState()
  const account = captureStorageScope()
  const generation = mamSearchGeneration
  return () => account.isCurrent() && generation === mamSearchGeneration &&
    searchStore.getState().query === state.query && searchStore.getState().pickedFilters === state.pickedFilters &&
    searchStore.getState().searchScope === state.searchScope &&
    searchStore.getState().searchFilter === state.searchFilter
}

/**
 * The tokens `from:<name>` stands for. In a one-to-one chat: the contact whose
 * JID, local part or name it is. In a room: the nick, plus the occupant ids
 * (XEP-0421) that nick has now among the occupants, which also find the
 * person's messages sent under an earlier nick.
 */
export function senderFilterTokens(name: string, scope: string | null): string[] {
  const selected = parseRoomSender(name)
  if (selected) return scope && scope !== selected.room ? ['\u0001unresolved-sender'] : [
    ...(selected.occupant ? [filterToken.occupant(selected.occupant, selected.room)] : []), filterToken.nick(selected.nick, selected.room),
  ]
  const lower = name.toLowerCase()
  const tokens = new Set<string>()
  if (name.includes('@')) tokens.add(filterToken.from(name))
  for (const [jid, entity] of chatStore.getState().conversationEntities) {
    if (scope && scope !== jid) continue
    if (jid.toLowerCase() === lower || jid.split('@')[0].toLowerCase() === lower || entity.name?.toLowerCase() === lower) {
      tokens.add(filterToken.from(jid))
    }
  }
  for (const [jid, room] of roomStore.getState().rooms) {
    if (scope && scope !== jid) continue
    tokens.add(filterToken.nick(name, jid))
    for (const occupant of room.occupants?.values() ?? []) {
      if (occupant.occupantId && occupant.nick.toLowerCase() === lower) tokens.add(filterToken.occupant(occupant.occupantId, jid))
    }
  }
  return tokens.size ? [...tokens] : ['\u0001unresolved-sender']
}

/** One group of filter tokens per `from:`, `is:mine` and `has:`; a message needs a token of each. */
function filterGroupsFor(input: ParsedSearchInput, scope: string | null): string[][] {
  return [
    ...(input.mine ? [[filterToken.mine]] : []),
    ...input.has.map((value) => [filterToken.has(value)]),
    ...input.from.map((name) => senderFilterTokens(name, scope)),
  ]
}

/** The start of a body, for a result found by its filters alone: no word to highlight. */
function leadSnippet(body: string): MatchSnippet {
  const text = body.length > 120 ? `${body.slice(0, 120)}…` : body
  return { text, matchStart: 0, matchEnd: 0 }
}

/** MAM `start`/`end` for the query's dates: `end` is inclusive there, so one millisecond earlier. */
function archiveSpan(input: ParsedSearchInput): { start?: string; end?: string } {
  return {
    ...(input.after !== undefined ? { start: new Date(input.after).toISOString() } : {}),
    ...(input.before !== undefined ? { end: new Date(input.before - 1).toISOString() } : {}),
  }
}

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

function selectRoomSearchTarget<T extends RoomIdentityFields>(incoming: RoomIdentityFields, candidates: readonly T[]): T | undefined {
  const scope = roomScope(incoming.roomJid)
  const matches = candidates.filter(candidate =>
    roomStanzaIdsMergeable(incoming, candidate) && sameLogicalMessage(scope, incoming, candidate))
  const selected = selectRoomMergeTargets(scope, incoming, mergeableOccupantCandidates(incoming, matches))
  return selected.find(candidate => !!incoming.occupantId && candidate.occupantId === incoming.occupantId) ?? selected[0]
}

function findResidentRoomMessage(msg: RoomMessage, roomJid: string): RoomMessage | undefined {
  return selectRoomSearchTarget(msg, (roomStore.getState().messages.get(roomJid) ?? [])
    .filter(candidate => candidate.from === msg.from))
}

function isRoomRetracted(msg: RoomMessage, roomJid: string, resident?: RoomMessage): boolean {
  const state = roomStore.getState()
  const current = resident ?? findResidentRoomMessage(msg, roomJid) ?? msg
  if (current.isRetracted) return true
  const pending = state.pendingRetractions.get(roomJid) ?? []
  return applyPendingRetractions(
    [current],
    pending,
    roomRetractionAuthorized
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
      if (resident) verdicts[position] = isRoomRetracted(candidate.message, candidate.roomJid, resident)
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
        isOutgoing: result.isOutgoing === true,
        ...(result.isDelayed ? { isDelayed: true } : {}),
        ...(result.receivedAt !== undefined ? { receivedAt: new Date(result.receivedAt) } : {}),
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
      isOutgoing: result.isOutgoing === true,
      ...(result.isDelayed ? { isDelayed: true } : {}),
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
    indexId: `mam:chat:${JSON.stringify([msg.conversationId, canonicalKey(CHAT_SCOPE, msg)])}`,
    messageId: msg.id,
    stanzaId: msg.stanzaId,
    originId: msg.originId,
    conversationId: msg.conversationId,
    conversationName: getConversationName(msg.conversationId, false),
    isRoom: false,
    from: msg.from,
    timestamp: msg.timestamp.getTime(),
    body: msg.body || '',
    matchSnippet: query ? generateMatchSnippet(msg.body || '', query, 60, phrases) : leadSnippet(msg.body || ''),
    source: 'mam',
    canonicalMessage: msg,
    ...(msg.isDelayed ? { isDelayed: true } : {}),
    ...(msg.isOutgoing ? { isOutgoing: true } : {}),
  }
}

/**
 * Convert a RoomMessage to a SearchResult.
 */
function roomMessageToSearchResult(msg: RoomMessage, roomJid: string, query: string, phrases?: string[]): SearchResult | null {
  if (isRoomRetracted(msg, roomJid)) return null
  return {
    indexId: `mam:room:${JSON.stringify([roomJid, msg.id, msg.occupantId ?? msg.from, msg.stanzaId ?? null])}`,
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
    matchSnippet: query ? generateMatchSnippet(msg.body || '', query, 60, phrases) : leadSnippet(msg.body || ''),
    source: 'mam',
    canonicalMessage: msg,
    ...(msg.isDelayed ? { isDelayed: true } : {}),
    ...(msg.isOutgoing ? { isOutgoing: true } : {}),
    ...(msg.receivedAt ? { receivedAt: msg.receivedAt.getTime() } : {}),
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
    if (mam.isRoom) {
      return !selectRoomSearchTarget({ ...searchResultIdentity(mam), roomJid: mam.conversationId },
        (candidates ?? []).filter(local => local.isRoom).map(local => ({
          ...searchResultIdentity(local), roomJid: local.conversationId,
        })))
    }
    return !candidates?.some(local => !local.isRoom &&
      !archiveIdentityConflict(local, mam) &&
      sameLogicalMessage(CHAT_SCOPE, searchResultIdentity(local), searchResultIdentity(mam)))
  })
}

function searchResultIdentity(result: SearchResult) {
  return {
    timestamp: result.timestamp,
    body: result.body,
    id: result.messageId,
    from: result.from,
    stanzaId: result.stanzaId,
    originId: result.originId,
    occupantId: result.occupantId,
    isDelayed: result.isDelayed,
    isOutgoing: result.isOutgoing,
    receivedAt: result.receivedAt,
    ...(result.isRoom ? { roomJid: result.conversationId } : {}),
  }
}

function sameChatSearchResultMessage(result: SearchResult, message: Message): boolean {
  return message.conversationId === result.conversationId &&
    !archiveIdentityConflict(result, message) &&
    sameLogicalMessage(CHAT_SCOPE, searchResultIdentity(result), message)
}

function roomContextMessage(message: RoomMessage, roomJid: string): ContextMessage {
  const state = roomStore.getState()
  const [resolved] = reconcileRoomMessageSnapshots([message], state.messages.get(roomJid), state.pendingRetractions.get(roomJid))
  return {
    roomMessage: resolved,
    body: resolved.body || '', nick: resolved.nick, from: resolved.from,
    timestamp: resolved.timestamp.getTime(), isRetracted: resolved.isRetracted,
    ...moderationMetadata(resolved),
  }
}

/**
 * Fetch context messages (1 before, 1 after) for local search results.
 * Called after results are set — updates resultContext asynchronously.
 */
async function fetchResultContexts(results: SearchResult[], query: string): Promise<void> {
  const isCurrent = searchSnapshot()
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
            getMessages('room', result.conversationId, { before: ts, limit: 1 }),
            getMessages('room', result.conversationId, { after: ts, limit: 2 }),
          ])
          const selected = selectRoomSearchTarget(
            { ...searchResultIdentity(result), roomJid: result.conversationId }, [...beforeMsgs, ...afterMsgs])
          before = beforeMsgs
            .filter(m => m !== selected)
            .map(m => roomContextMessage(m, result.conversationId))
          after = afterMsgs
            .filter(m => m !== selected)
            .slice(0, 1)
            .map(m => roomContextMessage(m, result.conversationId))
        } else {
          const [beforeMsgs, afterMsgs] = await Promise.all([
            getMessages('chat', result.conversationId, { before: ts, limit: 1 }),
            getMessages('chat', result.conversationId, { after: ts, limit: 2 }),
          ])
          before = beforeMsgs
            .filter(m => !sameChatSearchResultMessage(result, m))
            .map(m => ({ body: m.body || '', from: m.from, timestamp: m.timestamp.getTime(), isRetracted: isChatRetracted(m) }))
          after = afterMsgs
            .filter(m => !sameChatSearchResultMessage(result, m))
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
  if (isCurrent() && searchStore.getState().query.trim() === query && contextMap.size > 0) {
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
async function executeSearch(rawQuery: string): Promise<void> {
  // The field may end with a space (a completed suggestion adds one); the store keeps it as typed
  const query = rawQuery.trim()
  const state = searchStore.getState()
  const isCurrent = searchSnapshot()
  const scope = state.searchScope
  const filter = state.searchFilter
  const input = parseSearchInput(query, state.pickedFilters)
  const text = input.text
  const parsed = parseSearchQuery(text)
  const phrases = parsed.phrases.length > 0 ? parsed.phrases : undefined
  const filterGroups = filterGroupsFor(input, scope)
  if (invalidInput(input)) {
    searchStore.setState({ results: [], isSearching: false, error: 'Invalid search filters', filtersBuilding: false, filtersIncomplete: false, filtersUnavailable: null })
    return
  }
  try {
    const readiness = filterGroups.length ? await searchIndex.getFilterIndexState() : undefined
    if (!isCurrent()) return
    searchStore.setState({ filtersIncomplete: input.has.length > 0 && readiness?.status === 'incomplete',
      filtersUnavailable: readiness?.status === 'unavailable' ? readiness.reason ?? 'Search filter index unavailable' : null })
    if (readiness?.status === 'preparing' || readiness?.status === 'unavailable') {
      if (isCurrent() && searchStore.getState().query.trim() === query) {
        searchStore.setState({ results: [], isSearching: false, error: null, filtersBuilding: readiness?.status === 'preparing' })
      }
      return
    }
    const indexResults = await searchIndex.search(text, {
      ...(filterGroups.length > 0 ? { filterGroups } : {}),
      limit: 50,
      ...(scope ? { conversationId: scope } : {}),
      ...(filter === 'conversations' ? { isRoom: false } : {}),
      ...(filter === 'rooms' ? { isRoom: true } : {}),
      ...(input.after !== undefined ? { after: input.after } : {}),
      ...(input.before !== undefined ? { before: input.before } : {}),
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
        ...(r.isDelayed ? { isDelayed: true } : {}),
        ...(r.isOutgoing ? { isOutgoing: true } : {}),
        ...(r.receivedAt !== undefined ? { receivedAt: r.receivedAt } : {}),
        matchSnippet: text ? generateMatchSnippet(r.body, text, 60, phrases) : leadSnippet(r.body),
        source: 'local' as const,
      }
    })
    const results = projected.filter((result): result is SearchResult => result !== null)

    // Only update if the query hasn't changed while we were searching
    const current = searchStore.getState()
    if (isCurrent() && current.query.trim() === query) {
      // A no-match query maps to a fresh empty array; keeping the previous (also
      // empty) one avoids invalidating useSearch for a result set that did not change.
      const nextResults = results.length === 0 && current.results.length === 0 ? current.results : results
      searchStore.setState({ results: nextResults, isSearching: false, error: null, filtersBuilding: false })
      // Fire-and-forget: load context messages for results
      void fetchResultContexts(results, query)
    }
  } catch (err) {
    if (isCurrent() && searchStore.getState().query.trim() === query) {
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
  if ((!query && !state.pickedFilters.length) || !clientRef) return

  const generation = supersedeArchiveSearch()
  const isCurrent = searchSnapshot()
  const scope = state.searchScope
  const supportsFulltext = connectionStore.getState().mamFulltextSearch
  const input = parseSearchInput(query, state.pickedFilters)
  if (invalidInput(input)) {
    searchStore.setState({ isSearchingMAM: false, mamError: 'Invalid search filters', hasMoreMAMResults: false })
    return
  }
  const span = archiveSpan(input)
  const text = input.text
  const parsed = parseSearchQuery(text)
  const phrases = parsed.phrases.length > 0 ? parsed.phrases : undefined
  // The archive filters by text and date; from:, is: and has: are checked here on each page
  const filterGroups = filterGroupsFor(input, scope)
  const kept = <T extends Message | RoomMessage>(messages: T[]) =>
    filterGroups.length ? messages.filter((message) => matchesFilterTokens(message, filterGroups)) : messages
  const scopeIsRoom = !!scope && roomStore.getState().rooms.has(scope)
  // Without words only the client-side paging of a one-to-one chat can look for filters alone
  if (!text && (filterGroups.length === 0 || !scope || scopeIsRoom)) {
    searchStore.setState({ isSearchingMAM: false, mamError: 'The server archive needs words to search' })
    return
  }

  searchStore.setState({
    isSearchingMAM: true,
    mamSearched: true,
    mamError: null,
    ...(append ? {} : { mamResults: [] }),
  })

  const previousCursor = append ? mamRsmCursor : undefined
  try {
    let newResults: SearchResult[] = []
    let hasMore = false
    let nextCursor: string | undefined

    if (scope) {
      // Conversation-scoped search
      const isRoom = scopeIsRoom

      if (supportsFulltext && text) {
        // Server fulltext search scoped to conversation
        if (isRoom) {
          const result = await clientRef.messages.searchRoomMessages({
            query: text,
            roomJid: scope,
            ...span,
            max: 20,
            before: append ? mamRsmCursor : undefined,
          })
          newResults = await roomMessagesToSearchResults(kept(result.messages), scope, text, phrases)
          hasMore = !result.complete
          nextCursor = result.page.first
        } else {
          const result = await clientRef.messages.searchMessages({
            query: text,
            with: scope,
            ...span,
            max: 20,
            before: append ? mamRsmCursor : undefined,
          })
          newResults = await messagesToSearchResults(kept(result.messages), text, phrases)
          hasMore = !result.complete
          nextCursor = result.page.first
        }
      } else if (!isRoom) {
        // Paging search (1:1 conversations only, no fulltext required)
        const controller = new AbortController()
        pagingAbortController = controller
        const result = await clientRef.messages.searchConversationHistory(
          {
            query: text, with: scope, ...span, before: previousCursor, maxPages: 20, maxResults: 100,
            ...(filterGroups.length ? { filter: (message: Message) => matchesFilterTokens(message, filterGroups) } : {}),
          },
          controller.signal
        )
        if (pagingAbortController === controller) pagingAbortController = null
        newResults = await messagesToSearchResults(result.messages, text, phrases)
        hasMore = !result.complete
        nextCursor = result.page.first
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
        query: text,
        ...span,
        max: 20,
        before: append ? mamRsmCursor : undefined,
      })
      newResults = await messagesToSearchResults(kept(result.messages), text, phrases)
      hasMore = !result.complete
      nextCursor = result.page.first
    }

    // Check generation — discard if query changed
    if (generation !== mamSearchGeneration || !isCurrent()) return

    mamRsmCursor = nextCursor

    // Deduplicate against local results
    const localResults = searchStore.getState().results
    const existingMAM = append ? searchStore.getState().mamResults : []
    let deduplicated = deduplicateMAMResults([...localResults, ...existingMAM], newResults)

    // Apply type filter to MAM results
    const currentFilter = searchStore.getState().searchFilter
    if (currentFilter === 'conversations') {
      deduplicated = deduplicated.filter(r => !r.isRoom)
    } else if (currentFilter === 'rooms') {
      deduplicated = deduplicated.filter(r => r.isRoom)
    }

    // Index fetched messages locally for future searches
    void indexMAMResults(newResults)

    searchStore.setState({
      isSearchingMAM: false,
      mamResults: [...existingMAM, ...deduplicated],
      hasMoreMAMResults: hasMore && !!mamRsmCursor && mamRsmCursor !== previousCursor,
      mamError: null,
    })
  } catch (err) {
    if (generation !== mamSearchGeneration || !isCurrent()) return
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
  const account = captureStorageScope()
  try {
    const messages = results.flatMap(result => result.canonicalMessage ? [result.canonicalMessage] : [])
    const chatMessages = messages.filter((message): message is Message => message.type === 'chat')
    const roomMessages = messages.filter((message): message is RoomMessage => message.type === 'groupchat')

    // Index using the same search index used for local messages.
    if (chatMessages.length > 0) {
      account.assertCurrent()
      await searchIndex.indexMessages(chatMessages, {}, account.jid)
    }
    if (roomMessages.length > 0) {
      account.assertCurrent()
      await searchIndex.indexMessages(roomMessages, {}, account.jid)
    }
  } catch {
    // Silently ignore indexing errors — non-critical
  }
}

export const searchStore = createStore<SearchState>((set, get) => ({
  query: '',
  pickedFilters: [],
  filtersIncomplete: false,
  filtersUnavailable: null,
  setPickedFilters: (pickedFilters) => {
    set({ pickedFilters })
    get().search(get().query)
  },
  retryFilters: () => { void searchIndex.migrateSearchFilters() },
  isSearching: false,
  results: [],
  error: null,
  previewResult: null,
  isSearchingMAM: false,
  mamSearched: false,
  mamResults: [],
  hasMoreMAMResults: false,
  mamError: null,
  resultContext: new Map(),
  searchScope: null,
  searchFilter: 'all',
  inPrefixSuggestions: [],
  isInPrefixActive: false,
  filtersBuilding: false,

  search: (query: string) => {
    supersedeArchiveSearch()
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }

    const trimmed = query.trim()
    if (!trimmed && !get().pickedFilters.length) {
      set({ filtersIncomplete: false, filtersUnavailable: null, query: '', mamSearched: false, isSearchingMAM: false, isSearching: false, results: [], error: null, mamResults: [], mamError: null, hasMoreMAMResults: false, searchFilter: 'all', inPrefixSuggestions: [], isInPrefixActive: false, filtersBuilding: false })
      return
    }

    // Check for in: prefix
    const inParsed = parseInPrefix(trimmed)
    if (inParsed && !inParsed.rest) {
      // User is still typing the in: scope — show suggestions, don't search
      const suggestions = getInPrefixSuggestions(inParsed.inTerm)
      mamRsmCursor = undefined
      set({
        query,
        mamSearched: false,
        isSearchingMAM: false,
        mamResults: [],
        hasMoreMAMResults: false,
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
      mamSearched: false,
      isSearching: true,
      isSearchingMAM: false,
      error: null,
      mamError: null,
      hasMoreMAMResults: false,
    }
    if (prev.isInPrefixActive) patch.isInPrefixActive = false
    if (prev.inPrefixSuggestions.length > 0) patch.inPrefixSuggestions = []
    if (prev.mamResults.length > 0) patch.mamResults = []
    if (prev.resultContext.size > 0) patch.resultContext = new Map()
    set(patch)
    mamRsmCursor = undefined

    debounceTimer = setTimeout(() => {
      debounceTimer = null
      void executeSearch(trimmed)
    }, DEBOUNCE_MS)
  },

  clearSearch: () => {
    supersedeArchiveSearch()
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
    mamRsmCursor = undefined
    set({
      query: '',
      pickedFilters: [],
      filtersIncomplete: false,
      filtersUnavailable: null,
      isSearching: false,
      results: [],
      error: null,
      previewResult: null,
      isSearchingMAM: false,
      mamSearched: false,
      mamResults: [],
      hasMoreMAMResults: false,
      mamError: null,
      resultContext: new Map(),
      searchFilter: 'all',
      inPrefixSuggestions: [],
      isInPrefixActive: false,
      filtersBuilding: false,
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
    supersedeArchiveSearch()
    const state = searchStore.getState()
    set({
      searchScope: conversationId,
      mamSearched: false,
      isSearchingMAM: false,
      results: [],
      mamResults: [],
      mamError: null,
      hasMoreMAMResults: false,
    })
    mamRsmCursor = undefined
    // Re-run local search with new scope if there's an active query
    if (state.query || state.pickedFilters.length) {
      set({ isSearching: true })
      void executeSearch(state.query)
    }
  },

  setSearchFilter: (filter: SearchFilterType) => {
    supersedeArchiveSearch()
    const state = searchStore.getState()
    set({
      searchFilter: filter,
      mamSearched: false,
      isSearchingMAM: false,
      results: [],
      mamResults: [],
      mamError: null,
      hasMoreMAMResults: false,
    })
    mamRsmCursor = undefined
    // Re-run local search with new filter if there's an active query
    if (state.query.trim() || state.pickedFilters.length) {
      set({ isSearching: true })
      void executeSearch(state.query.trim())
    }
  },

  selectInPrefixSuggestion: (suggestion: InPrefixSuggestion) => {
    supersedeArchiveSearch()
    const state = searchStore.getState()
    const inParsed = parseInPrefix(state.query.trim())
    const restQuery = inParsed?.rest || ''

    // Set scope via existing mechanism
    set({
      searchScope: suggestion.id,
      mamSearched: false,
      isSearchingMAM: false,
      query: restQuery,
      inPrefixSuggestions: [],
      isInPrefixActive: false,
      results: [],
      mamResults: [],
      mamError: null,
      hasMoreMAMResults: false,
    })
    mamRsmCursor = undefined

    if (restQuery.trim() || state.pickedFilters.length) {
      set({ isSearching: true })
      void executeSearch(restQuery.trim())
    }
  },
}))

searchIndex.subscribeFilterIndex(() => {
  const state = searchStore.getState()
  if (state.filtersBuilding || state.filtersUnavailable || state.filtersIncomplete) void executeSearch(state.query)
})

connectionStore.subscribe((state, previous) => {
  if (state.jid !== previous.jid) {
    searchStore.getState().clearSearch()
    searchStore.getState().setSearchScope(null)
  }
})
