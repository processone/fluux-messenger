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
import type { XMPPClient } from '../core/XMPPClient'
import type { Message, RoomMessage } from '../core/types'

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

  /** Conversation scope: null = global, JID = conversation-scoped */
  searchScope: string | null

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

/**
 * Convert a Message to a SearchResult.
 */
function messageToSearchResult(msg: Message, query: string, phrases?: string[]): SearchResult {
  return {
    indexId: `mam:chat:${msg.id}`,
    messageId: msg.id,
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
function roomMessageToSearchResult(msg: RoomMessage, roomJid: string, query: string, phrases?: string[]): SearchResult {
  return {
    indexId: `mam:room:${msg.id}`,
    messageId: msg.id,
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

/**
 * Deduplicate MAM results against local results.
 * Returns only MAM results whose messageId is not in the local results set.
 */
export function deduplicateMAMResults(
  localResults: SearchResult[],
  mamResults: SearchResult[]
): SearchResult[] {
  const localIds = new Set(localResults.map(r => r.messageId))
  return mamResults.filter(r => !localIds.has(r.messageId))
}

/**
 * Perform the actual local search and update the store.
 */
async function executeSearch(query: string): Promise<void> {
  const scope = searchStore.getState().searchScope
  const parsed = parseSearchQuery(query)
  const phrases = parsed.phrases.length > 0 ? parsed.phrases : undefined
  try {
    const indexResults = await searchIndex.search(query, {
      limit: 50,
      ...(scope ? { conversationId: scope } : {}),
    })

    const results: SearchResult[] = indexResults.map((r) => ({
      indexId: r.indexId,
      messageId: r.messageId,
      conversationId: r.conversationId,
      conversationName: getConversationName(r.conversationId, r.isRoom),
      isRoom: r.isRoom,
      from: r.from,
      nick: r.nick,
      timestamp: r.timestamp,
      body: r.body,
      matchSnippet: generateMatchSnippet(r.body, query, 60, phrases),
      source: 'local' as const,
    }))

    // Only update if the query hasn't changed while we were searching
    if (searchStore.getState().query === query) {
      searchStore.setState({ results, isSearching: false, error: null })
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
          const result = await clientRef.mam.searchRoomArchive({
            query,
            roomJid: scope,
            max: 20,
            before: append ? mamRsmCursor : undefined,
          })
          newResults = result.messages.map(m => roomMessageToSearchResult(m, scope, query, phrases))
          hasMore = !result.complete
          mamRsmCursor = result.rsm.first
        } else {
          const result = await clientRef.mam.searchArchive({
            query,
            with: scope,
            max: 20,
            before: append ? mamRsmCursor : undefined,
          })
          newResults = result.messages.map(m => messageToSearchResult(m, query, phrases))
          hasMore = !result.complete
          mamRsmCursor = result.rsm.first
        }
      } else if (!isRoom) {
        // Paging search (1:1 conversations only, no fulltext required)
        pagingAbortController = new AbortController()
        const result = await clientRef.mam.searchConversationByPaging(
          { query, with: scope, maxPages: 20, maxResults: 50 },
          pagingAbortController.signal
        )
        pagingAbortController = null
        newResults = result.messages.map(m => messageToSearchResult(m, query, phrases))
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

      const result = await clientRef.mam.searchArchive({
        query,
        max: 20,
        before: append ? mamRsmCursor : undefined,
      })
      newResults = result.messages.map(m => messageToSearchResult(m, query, phrases))
      hasMore = !result.complete
      mamRsmCursor = result.rsm.first
    }

    // Check generation — discard if query changed
    if (generation !== mamSearchGeneration) return

    // Deduplicate against local results
    const localResults = searchStore.getState().results
    const deduplicated = deduplicateMAMResults(localResults, newResults)

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
    // Build minimal message objects for indexing
    const chatMessages: Array<{ id: string; conversationId: string; from: string; body: string; timestamp: Date; isRoom: false }> = []
    const roomMessages: Array<{ id: string; roomJid: string; from: string; nick?: string; body: string; timestamp: Date; isRoom: true }> = []

    for (const r of results) {
      if (r.isRoom) {
        roomMessages.push({
          id: r.messageId,
          roomJid: r.conversationId,
          from: r.from,
          nick: r.nick,
          body: r.body,
          timestamp: new Date(r.timestamp),
          isRoom: true,
        })
      } else {
        chatMessages.push({
          id: r.messageId,
          conversationId: r.conversationId,
          from: r.from,
          body: r.body,
          timestamp: new Date(r.timestamp),
          isRoom: false,
        })
      }
    }

    // Index using the same search index used for local messages
    if (chatMessages.length > 0) {
      await searchIndex.indexMessages(chatMessages as any)
    }
    if (roomMessages.length > 0) {
      await searchIndex.indexMessages(roomMessages as any)
    }
  } catch {
    // Silently ignore indexing errors — non-critical
  }
}

export const searchStore = createStore<SearchState>((set) => ({
  query: '',
  isSearching: false,
  results: [],
  error: null,
  previewResult: null,
  isSearchingMAM: false,
  mamResults: [],
  hasMoreMAMResults: false,
  mamError: null,
  searchScope: null,

  search: (query: string) => {
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }

    const trimmed = query.trim()
    if (!trimmed) {
      set({ query: '', isSearching: false, results: [], error: null, mamResults: [], mamError: null, hasMoreMAMResults: false })
      mamSearchGeneration++  // Cancel any in-flight MAM search
      return
    }

    // Reset MAM results on new query
    set({ query, isSearching: true, error: null, mamResults: [], mamError: null, hasMoreMAMResults: false })
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
}))
