/**
 * Search store for managing full-text search state.
 *
 * Ephemeral state — no persistence. Coordinates search queries
 * against the search index and enriches results with conversation metadata.
 *
 * @module SearchStore
 */

import { createStore } from 'zustand/vanilla'
import * as searchIndex from '../utils/searchIndex'
import { generateMatchSnippet, type MatchSnippet } from '../utils/searchUtils'
import { chatStore } from './chatStore'
import { roomStore } from './roomStore'

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
}

export interface SearchState {
  /** Current search query */
  query: string
  /** Whether a search is in progress */
  isSearching: boolean
  /** Search results sorted by recency */
  results: SearchResult[]
  /** Error message if search failed */
  error: string | null
  /** Search result currently being previewed in the context view */
  previewResult: SearchResult | null

  /** Execute a search (debounced internally) */
  search: (query: string) => void
  /** Clear search state */
  clearSearch: () => void
  /** Set the search result to preview in context */
  setPreviewResult: (result: SearchResult | null) => void
}

/** Debounce timer for search input */
let debounceTimer: ReturnType<typeof setTimeout> | null = null
const DEBOUNCE_MS = 300

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
 * Perform the actual search and update the store.
 */
async function executeSearch(query: string): Promise<void> {
  try {
    const indexResults = await searchIndex.search(query, { limit: 50 })

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
      matchSnippet: generateMatchSnippet(r.body, query),
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

export const searchStore = createStore<SearchState>((set) => ({
  query: '',
  isSearching: false,
  results: [],
  error: null,
  previewResult: null,

  search: (query: string) => {
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }

    const trimmed = query.trim()
    if (!trimmed) {
      set({ query: '', isSearching: false, results: [], error: null })
      return
    }

    set({ query: trimmed, isSearching: true, error: null })

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
    set({ query: '', isSearching: false, results: [], error: null, previewResult: null })
  },

  setPreviewResult: (result: SearchResult | null) => {
    set({ previewResult: result })
  },
}))
