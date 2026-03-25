/**
 * React hook for full-text message search.
 *
 * Provides access to local and MAM search state and actions.
 *
 * @example
 * ```tsx
 * function SearchPanel() {
 *   const { query, results, mamResults, isSearching, search, searchMAM } = useSearch()
 *
 *   return (
 *     <div>
 *       <input
 *         value={query}
 *         onChange={(e) => search(e.target.value)}
 *         placeholder="Search messages..."
 *       />
 *       {isSearching && <Spinner />}
 *       {results.map((r) => (
 *         <SearchResultItem key={r.indexId} result={r} />
 *       ))}
 *       <button onClick={searchMAM}>Search server archive</button>
 *       {mamResults.map((r) => (
 *         <SearchResultItem key={r.indexId} result={r} />
 *       ))}
 *     </div>
 *   )
 * }
 * ```
 *
 * @module Hooks/useSearch
 */

import { useStore } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { searchStore, type SearchResult, type SearchResultContext, type SearchFilterType, type InPrefixSuggestion } from '../stores/searchStore'

/**
 * Hook for searching messages across all conversations and rooms.
 *
 * Local search is debounced (300ms) and queries a local IndexedDB inverted index.
 * MAM search queries the server archive on demand.
 */
export function useSearch() {
  const {
    query,
    isSearching,
    results,
    error,
    previewResult,
    isSearchingMAM,
    mamResults,
    hasMoreMAMResults,
    mamError,
    searchScope,
    resultContext,
    searchFilter,
    inPrefixSuggestions,
    isInPrefixActive,
  } = useStore(
    searchStore,
    useShallow((state) => ({
      query: state.query,
      isSearching: state.isSearching,
      results: state.results,
      error: state.error,
      previewResult: state.previewResult,
      isSearchingMAM: state.isSearchingMAM,
      mamResults: state.mamResults,
      hasMoreMAMResults: state.hasMoreMAMResults,
      mamError: state.mamError,
      searchScope: state.searchScope,
      resultContext: state.resultContext,
      searchFilter: state.searchFilter,
      inPrefixSuggestions: state.inPrefixSuggestions,
      isInPrefixActive: state.isInPrefixActive,
    }))
  )

  return {
    /** Current search query */
    query,
    /** Whether a local search is in progress */
    isSearching,
    /** Local search results sorted by recency */
    results,
    /** Error message if local search failed */
    error,
    /** Search result currently being previewed in context */
    previewResult,
    /** Whether a MAM search is in progress */
    isSearchingMAM,
    /** MAM search results (deduplicated against local results) */
    mamResults,
    /** Whether more MAM results are available */
    hasMoreMAMResults,
    /** Error message if MAM search failed */
    mamError,
    /** Conversation scope: null = global, JID = conversation-scoped */
    searchScope,
    /** Context messages around search results (keyed by indexId) */
    resultContext,
    /** Filter by conversation type */
    searchFilter,
    /** Autocomplete suggestions for `in:` prefix */
    inPrefixSuggestions,
    /** Whether the `in:` autocomplete is active */
    isInPrefixActive,
    /** Execute a local search (debounced 300ms) */
    search: searchStore.getState().search,
    /** Clear all search state and results */
    clearSearch: searchStore.getState().clearSearch,
    /** Set the search result to preview in context */
    setPreviewResult: searchStore.getState().setPreviewResult,
    /** Trigger MAM search for the current query */
    searchMAM: searchStore.getState().searchMAM,
    /** Load more MAM results (pagination) */
    loadMoreMAMResults: searchStore.getState().loadMoreMAMResults,
    /** Set conversation scope for search */
    setSearchScope: searchStore.getState().setSearchScope,
    /** Set search filter type */
    setSearchFilter: searchStore.getState().setSearchFilter,
    /** Select an `in:` prefix suggestion */
    selectInPrefixSuggestion: searchStore.getState().selectInPrefixSuggestion,
  }
}

export type { SearchResult, SearchResultContext, SearchFilterType, InPrefixSuggestion }
