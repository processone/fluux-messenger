import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { searchStore, setSearchClient, deduplicateMAMResults, parseInPrefix, getInPrefixSuggestions, type SearchResult } from './searchStore'
import { chatStore } from './chatStore'
import { roomStore } from './roomStore'
import { connectionStore } from './connectionStore'
import * as searchIndex from '../utils/searchIndex'
import type { SearchIndexResult } from '../utils/searchIndex'
import * as messageCache from '../utils/messageCache'

// Mock the search index to avoid IDB dependency in store tests
vi.mock('../utils/searchIndex', async () => {
  const actual = await vi.importActual('../utils/searchIndex')
  return {
    search: vi.fn().mockResolvedValue([]),
    indexMessage: vi.fn().mockResolvedValue(undefined),
    indexMessages: vi.fn().mockResolvedValue(undefined),
    removeMessage: vi.fn().mockResolvedValue(undefined),
    updateMessage: vi.fn().mockResolvedValue(undefined),
    parseSearchQuery: (actual as Record<string, unknown>).parseSearchQuery,
    tokenize: (actual as Record<string, unknown>).tokenize,
  }
})

// Mock messageCache to avoid IDB dependency
vi.mock('../utils/messageCache', () => ({
  getMessages: vi.fn().mockResolvedValue([]),
  getRoomMessages: vi.fn().mockResolvedValue([]),
}))

// Mock localStorage for chatStore/roomStore (they use persist middleware)
const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value },
    removeItem: (key: string) => { delete store[key] },
    clear: () => { store = {} },
  }
})()
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true })

describe('searchStore', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()

    // Reset search store state (including MAM fields)
    searchStore.setState({
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
      resultContext: new Map(),
      searchFilter: 'all',
      inPrefixSuggestions: [],
      isInPrefixActive: false,
    })

    // Set up chatStore with test data for conversation name resolution
    chatStore.setState({
      conversationEntities: new Map([
        ['alice@example.com', { id: 'alice@example.com', name: 'Alice', type: 'chat' as const }],
        ['bob@example.com', { id: 'bob@example.com', name: 'Bob', type: 'chat' as const }],
      ]),
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // ===========================================================================
  // search action
  // ===========================================================================

  describe('search', () => {
    it('should set query and isSearching immediately', () => {
      searchStore.getState().search('hello')

      const state = searchStore.getState()
      expect(state.query).toBe('hello')
      expect(state.isSearching).toBe(true)
    })

    it('should debounce the actual search call', () => {
      searchStore.getState().search('hello')

      // Search index should NOT be called yet (debounce)
      expect(searchIndex.search).not.toHaveBeenCalled()

      // Advance past debounce time (300ms)
      vi.advanceTimersByTime(300)

      expect(searchIndex.search).toHaveBeenCalledWith('hello', { limit: 50 })
    })

    it('should cancel previous debounce when typing continues', () => {
      searchStore.getState().search('hel')
      vi.advanceTimersByTime(100) // Only 100ms elapsed

      searchStore.getState().search('hello')
      vi.advanceTimersByTime(100) // 100ms after second call

      // Still not called - debounce restarted
      expect(searchIndex.search).not.toHaveBeenCalled()

      vi.advanceTimersByTime(200) // Total 300ms after last call

      // Should only search for the final query
      expect(searchIndex.search).toHaveBeenCalledTimes(1)
      expect(searchIndex.search).toHaveBeenCalledWith('hello', { limit: 50 })
    })

    it('should preserve raw query for controlled input but trim for search execution', () => {
      searchStore.getState().search('  hello  ')

      // Raw query preserved for controlled input display
      expect(searchStore.getState().query).toBe('  hello  ')

      // But the debounced search should use the trimmed value
      vi.advanceTimersByTime(300)
      expect(searchIndex.search).toHaveBeenCalledWith('hello', { limit: 50 })
    })

    it('should clear results for empty query', () => {
      // Set some existing state
      searchStore.setState({
        query: 'old',
        results: [{ indexId: 'test', messageId: 'test', conversationId: 'x', conversationName: 'X', isRoom: false, from: 'y', timestamp: 0, body: 'z', matchSnippet: null, source: 'local' as const }],
        isSearching: true,
      })

      searchStore.getState().search('')

      const state = searchStore.getState()
      expect(state.query).toBe('')
      expect(state.results).toEqual([])
      expect(state.isSearching).toBe(false)
    })

    it('should enrich results with conversation names', async () => {
      const mockResults: SearchIndexResult[] = [
        {
          indexId: 'chat:msg-1',
          messageId: 'msg-1',
          conversationId: 'alice@example.com',
          from: 'alice@example.com',
          timestamp: Date.now(),
          isRoom: false,
          body: 'Hello from Alice',
        },
      ]
      vi.mocked(searchIndex.search).mockResolvedValueOnce(mockResults)

      searchStore.getState().search('hello')
      vi.advanceTimersByTime(300)

      // Wait for the async search to complete
      await vi.runAllTimersAsync()

      const state = searchStore.getState()
      expect(state.results).toHaveLength(1)
      expect(state.results[0].conversationName).toBe('Alice')
      expect(state.isSearching).toBe(false)
    })

    it('should fall back to conversationId when name not found', async () => {
      const mockResults: SearchIndexResult[] = [
        {
          indexId: 'chat:msg-1',
          messageId: 'msg-1',
          conversationId: 'unknown@example.com',
          from: 'unknown@example.com',
          timestamp: Date.now(),
          isRoom: false,
          body: 'Message from unknown',
        },
      ]
      vi.mocked(searchIndex.search).mockResolvedValueOnce(mockResults)

      searchStore.getState().search('message')
      vi.advanceTimersByTime(300)
      await vi.runAllTimersAsync()

      const state = searchStore.getState()
      expect(state.results[0].conversationName).toBe('unknown@example.com')
    })

    it('should generate match snippets', async () => {
      const mockResults: SearchIndexResult[] = [
        {
          indexId: 'chat:msg-1',
          messageId: 'msg-1',
          conversationId: 'alice@example.com',
          from: 'alice@example.com',
          timestamp: Date.now(),
          isRoom: false,
          body: 'The quarterly report is ready for review',
        },
      ]
      vi.mocked(searchIndex.search).mockResolvedValueOnce(mockResults)

      searchStore.getState().search('quarterly')
      vi.advanceTimersByTime(300)
      await vi.runAllTimersAsync()

      const state = searchStore.getState()
      expect(state.results[0].matchSnippet).not.toBeNull()
      expect(state.results[0].matchSnippet!.text).toContain('quarterly')
    })

    it('should handle search errors gracefully', async () => {
      vi.mocked(searchIndex.search).mockRejectedValueOnce(new Error('IDB error'))

      searchStore.getState().search('hello')
      vi.advanceTimersByTime(300)
      await vi.runAllTimersAsync()

      const state = searchStore.getState()
      expect(state.isSearching).toBe(false)
      expect(state.error).toBe('IDB error')
      expect(state.results).toEqual([])
    })

    it('should discard stale results when query changes', async () => {
      // First search returns results
      const staleResults: SearchIndexResult[] = [
        {
          indexId: 'chat:msg-1',
          messageId: 'msg-1',
          conversationId: 'alice@example.com',
          from: 'alice@example.com',
          timestamp: Date.now(),
          isRoom: false,
          body: 'Stale result',
        },
      ]

      // Mock search to return stale results but after a delay
      vi.mocked(searchIndex.search).mockImplementation(async (query) => {
        if (query === 'stale') return staleResults
        return []
      })

      searchStore.getState().search('stale')
      vi.advanceTimersByTime(100) // Don't complete debounce

      // Change query before first search completes
      searchStore.getState().search('fresh')
      vi.advanceTimersByTime(300)
      await vi.runAllTimersAsync()

      // Should have searched for 'fresh', not 'stale'
      const state = searchStore.getState()
      expect(state.query).toBe('fresh')
    })
  })

  // ===========================================================================
  // clearSearch
  // ===========================================================================

  describe('clearSearch', () => {
    it('should reset all state', () => {
      searchStore.setState({
        query: 'test',
        isSearching: true,
        results: [{ indexId: 'x', messageId: 'x', conversationId: 'y', conversationName: 'Y', isRoom: false, from: 'z', timestamp: 0, body: 'w', matchSnippet: null, source: 'local' as const }],
        error: 'some error',
      })

      searchStore.getState().clearSearch()

      const state = searchStore.getState()
      expect(state.query).toBe('')
      expect(state.isSearching).toBe(false)
      expect(state.results).toEqual([])
      expect(state.error).toBeNull()
    })

    it('should cancel pending debounced search', () => {
      searchStore.getState().search('hello')
      // Don't advance timers — debounce still pending

      searchStore.getState().clearSearch()
      vi.advanceTimersByTime(500) // Advance past debounce

      // The search should not have been executed
      expect(searchIndex.search).not.toHaveBeenCalled()
    })

    it('should also clear MAM state', () => {
      searchStore.setState({
        query: 'test',
        mamResults: [{ indexId: 'mam:1', messageId: 'm1', conversationId: 'x', conversationName: 'X', isRoom: false, from: 'y', timestamp: 0, body: 'z', matchSnippet: null, source: 'mam' as const }],
        isSearchingMAM: true,
        hasMoreMAMResults: true,
        mamError: 'some error',
      })

      searchStore.getState().clearSearch()

      const state = searchStore.getState()
      expect(state.mamResults).toEqual([])
      expect(state.isSearchingMAM).toBe(false)
      expect(state.hasMoreMAMResults).toBe(false)
      expect(state.mamError).toBeNull()
    })
  })

  // ===========================================================================
  // deduplicateMAMResults
  // ===========================================================================

  describe('deduplicateMAMResults', () => {
    const makeResult = (messageId: string, source: 'local' | 'mam'): SearchResult => ({
      indexId: `${source}:${messageId}`,
      messageId,
      conversationId: 'alice@example.com',
      conversationName: 'Alice',
      isRoom: false,
      from: 'alice@example.com',
      timestamp: Date.now(),
      body: 'test message',
      matchSnippet: null,
      source,
    })

    it('should filter out MAM results that already exist in local results', () => {
      const local = [makeResult('msg-1', 'local'), makeResult('msg-2', 'local')]
      const mam = [makeResult('msg-2', 'mam'), makeResult('msg-3', 'mam')]

      const result = deduplicateMAMResults(local, mam)

      expect(result).toHaveLength(1)
      expect(result[0].messageId).toBe('msg-3')
    })

    it('should return all MAM results when no overlap with local', () => {
      const local = [makeResult('msg-1', 'local')]
      const mam = [makeResult('msg-2', 'mam'), makeResult('msg-3', 'mam')]

      const result = deduplicateMAMResults(local, mam)

      expect(result).toHaveLength(2)
    })

    it('should return empty array when all MAM results are duplicates', () => {
      const local = [makeResult('msg-1', 'local'), makeResult('msg-2', 'local')]
      const mam = [makeResult('msg-1', 'mam'), makeResult('msg-2', 'mam')]

      const result = deduplicateMAMResults(local, mam)

      expect(result).toEqual([])
    })

    it('should handle empty inputs', () => {
      expect(deduplicateMAMResults([], [])).toEqual([])
      expect(deduplicateMAMResults([makeResult('msg-1', 'local')], [])).toEqual([])
      expect(deduplicateMAMResults([], [makeResult('msg-1', 'mam')])).toHaveLength(1)
    })
  })

  // ===========================================================================
  // setSearchScope
  // ===========================================================================

  describe('setSearchScope', () => {
    it('should set the search scope', () => {
      searchStore.getState().setSearchScope('alice@example.com')

      expect(searchStore.getState().searchScope).toBe('alice@example.com')
    })

    it('should clear the search scope', () => {
      searchStore.setState({ searchScope: 'alice@example.com' })

      searchStore.getState().setSearchScope(null)

      expect(searchStore.getState().searchScope).toBeNull()
    })

    it('should reset results when scope changes', () => {
      searchStore.setState({
        results: [{ indexId: 'x', messageId: 'x', conversationId: 'y', conversationName: 'Y', isRoom: false, from: 'z', timestamp: 0, body: 'w', matchSnippet: null, source: 'local' as const }],
        mamResults: [{ indexId: 'mam:x', messageId: 'x2', conversationId: 'y', conversationName: 'Y', isRoom: false, from: 'z', timestamp: 0, body: 'w', matchSnippet: null, source: 'mam' as const }],
      })

      searchStore.getState().setSearchScope('bob@example.com')

      const state = searchStore.getState()
      expect(state.results).toEqual([])
      expect(state.mamResults).toEqual([])
    })

    it('should re-run local search with scope when query exists', () => {
      searchStore.setState({ query: 'hello' })

      searchStore.getState().setSearchScope('alice@example.com')
      vi.advanceTimersByTime(0) // synchronous re-search

      // executeSearch is called with conversationId filter
      expect(searchStore.getState().isSearching).toBe(true)
    })

    it('should pass conversationId filter to searchIndex when scoped', async () => {
      searchStore.setState({ query: 'hello', searchScope: 'alice@example.com' })
      searchStore.getState().setSearchScope('alice@example.com')

      // Manually trigger the search since setSearchScope calls executeSearch
      await vi.runAllTimersAsync()

      expect(searchIndex.search).toHaveBeenCalledWith('hello', expect.objectContaining({
        conversationId: 'alice@example.com',
      }))
    })
  })

  // ===========================================================================
  // resultContext (context messages around search results)
  // ===========================================================================

  describe('resultContext', () => {
    const now = Date.now()

    it('should fetch context messages after local search completes', async () => {
      const mockResults: SearchIndexResult[] = [
        {
          indexId: 'chat:msg-2',
          messageId: 'msg-2',
          conversationId: 'alice@example.com',
          from: 'alice@example.com',
          timestamp: now,
          isRoom: false,
          body: 'Hello from Alice',
        },
      ]
      vi.mocked(searchIndex.search).mockResolvedValueOnce(mockResults)

      // Set up messageCache to return context messages
      vi.mocked(messageCache.getMessages)
        .mockResolvedValueOnce([
          { id: 'msg-1', conversationId: 'alice@example.com', from: 'alice@example.com', body: 'Previous message', timestamp: new Date(now - 5000), isOutgoing: false, type: 'chat' as const },
        ]) // before
        .mockResolvedValueOnce([
          { id: 'msg-3', conversationId: 'alice@example.com', from: 'bob@example.com', body: 'Next message', timestamp: new Date(now + 5000), isOutgoing: false, type: 'chat' as const },
        ]) // after

      searchStore.getState().search('hello')
      await vi.runAllTimersAsync()

      // Wait for async context fetch
      await vi.waitFor(() => {
        expect(searchStore.getState().resultContext.size).toBe(1)
      })

      const ctx = searchStore.getState().resultContext.get('chat:msg-2')
      expect(ctx).toBeDefined()
      expect(ctx!.before).toHaveLength(1)
      expect(ctx!.before[0].body).toBe('Previous message')
      expect(ctx!.after).toHaveLength(1)
      expect(ctx!.after[0].body).toBe('Next message')
    })

    it('should not include the matched message itself in context', async () => {
      const mockResults: SearchIndexResult[] = [
        {
          indexId: 'chat:msg-2',
          messageId: 'msg-2',
          conversationId: 'alice@example.com',
          from: 'alice@example.com',
          timestamp: now,
          isRoom: false,
          body: 'Hello from Alice',
        },
      ]
      vi.mocked(searchIndex.search).mockResolvedValueOnce(mockResults)

      // "after" query returns the matched message + a next message
      vi.mocked(messageCache.getMessages)
        .mockResolvedValueOnce([]) // before: nothing
        .mockResolvedValueOnce([
          { id: 'msg-2', conversationId: 'alice@example.com', from: 'alice@example.com', body: 'Hello from Alice', timestamp: new Date(now), isOutgoing: false, type: 'chat' as const },
          { id: 'msg-3', conversationId: 'alice@example.com', from: 'bob@example.com', body: 'Reply', timestamp: new Date(now + 5000), isOutgoing: false, type: 'chat' as const },
        ]) // after: includes matched msg + next

      searchStore.getState().search('hello')
      await vi.runAllTimersAsync()

      await vi.waitFor(() => {
        expect(searchStore.getState().resultContext.size).toBe(1)
      })

      const ctx = searchStore.getState().resultContext.get('chat:msg-2')
      expect(ctx!.after).toHaveLength(1)
      expect(ctx!.after[0].body).toBe('Reply')
    })

    it('should clear resultContext when query changes', () => {
      searchStore.setState({
        resultContext: new Map([['test', { before: [], after: [] }]]),
      })

      searchStore.getState().search('new query')

      expect(searchStore.getState().resultContext.size).toBe(0)
    })

    it('should clear resultContext on clearSearch', () => {
      searchStore.setState({
        resultContext: new Map([['test', { before: [], after: [] }]]),
      })

      searchStore.getState().clearSearch()

      expect(searchStore.getState().resultContext.size).toBe(0)
    })
  })

  // ===========================================================================
  // searchMAM
  // ===========================================================================

  describe('searchMAM', () => {
    it('should not execute MAM search without a client reference', () => {
      setSearchClient(null)
      searchStore.setState({ query: 'hello' })

      searchStore.getState().searchMAM()

      // Should not set isSearchingMAM since there's no client
      expect(searchStore.getState().isSearchingMAM).toBe(false)
    })

    it('should not execute MAM search without a query', () => {
      const mockClient = createMockMAMClient()
      setSearchClient(mockClient as any)
      searchStore.setState({ query: '' })

      searchStore.getState().searchMAM()

      expect(searchStore.getState().isSearchingMAM).toBe(false)
    })

    it('should set isSearchingMAM when starting a MAM search', async () => {
      const mockClient = createMockMAMClient()
      setSearchClient(mockClient as any)
      connectionStore.getState().setMAMFulltextSearch(true)
      searchStore.setState({ query: 'hello' })

      searchStore.getState().searchMAM()

      expect(searchStore.getState().isSearchingMAM).toBe(true)

      // Clean up
      await vi.runAllTimersAsync()
    })

    it('should show error for global search without fulltext support', async () => {
      const mockClient = createMockMAMClient()
      setSearchClient(mockClient as any)
      connectionStore.getState().setMAMFulltextSearch(false)
      searchStore.setState({ query: 'hello', searchScope: null })

      searchStore.getState().searchMAM()
      await vi.runAllTimersAsync()

      const state = searchStore.getState()
      expect(state.isSearchingMAM).toBe(false)
      expect(state.mamError).toContain('does not support')
    })

    it('should call searchArchive for global fulltext search', async () => {
      const mockClient = createMockMAMClient()
      setSearchClient(mockClient as any)
      connectionStore.getState().setMAMFulltextSearch(true)
      searchStore.setState({ query: 'hello', searchScope: null })

      searchStore.getState().searchMAM()
      await vi.runAllTimersAsync()

      expect(mockClient.mam.searchArchive).toHaveBeenCalledWith(expect.objectContaining({
        query: 'hello',
        max: 20,
      }))
    })

    it('should call searchArchive with "with" filter for conversation-scoped fulltext search', async () => {
      const mockClient = createMockMAMClient()
      setSearchClient(mockClient as any)
      connectionStore.getState().setMAMFulltextSearch(true)
      searchStore.setState({ query: 'hello', searchScope: 'alice@example.com' })

      searchStore.getState().searchMAM()
      await vi.runAllTimersAsync()

      expect(mockClient.mam.searchArchive).toHaveBeenCalledWith(expect.objectContaining({
        query: 'hello',
        with: 'alice@example.com',
      }))
    })

    it('should call searchConversationByPaging for scoped search without fulltext', async () => {
      const mockClient = createMockMAMClient()
      setSearchClient(mockClient as any)
      connectionStore.getState().setMAMFulltextSearch(false)
      searchStore.setState({ query: 'hello', searchScope: 'alice@example.com' })

      searchStore.getState().searchMAM()
      await vi.runAllTimersAsync()

      expect(mockClient.mam.searchConversationByPaging).toHaveBeenCalledWith(
        expect.objectContaining({
          query: 'hello',
          with: 'alice@example.com',
        }),
        expect.any(AbortSignal)
      )
    })

    it('should deduplicate MAM results against local results', async () => {
      const mockClient = createMockMAMClient({
        searchArchiveResults: [
          { id: 'msg-1', conversationId: 'alice@example.com', from: 'alice@example.com', body: 'hello world', timestamp: new Date() },
          { id: 'msg-2', conversationId: 'alice@example.com', from: 'alice@example.com', body: 'hello again', timestamp: new Date() },
        ],
      })
      setSearchClient(mockClient as any)
      connectionStore.getState().setMAMFulltextSearch(true)

      // Set up local results that overlap with msg-1
      searchStore.setState({
        query: 'hello',
        searchScope: null,
        results: [{ indexId: 'local:msg-1', messageId: 'msg-1', conversationId: 'alice@example.com', conversationName: 'Alice', isRoom: false, from: 'alice@example.com', timestamp: Date.now(), body: 'hello world', matchSnippet: null, source: 'local' as const }],
      })

      searchStore.getState().searchMAM()
      await vi.runAllTimersAsync()

      const state = searchStore.getState()
      // Only msg-2 should appear in MAM results (msg-1 is deduplicated)
      expect(state.mamResults).toHaveLength(1)
      expect(state.mamResults[0].messageId).toBe('msg-2')
    })

    it('should handle MAM search errors gracefully', async () => {
      const mockClient = createMockMAMClient()
      mockClient.mam.searchArchive.mockRejectedValueOnce(new Error('Server error'))
      setSearchClient(mockClient as any)
      connectionStore.getState().setMAMFulltextSearch(true)
      searchStore.setState({ query: 'hello', searchScope: null })

      searchStore.getState().searchMAM()
      await vi.runAllTimersAsync()

      const state = searchStore.getState()
      expect(state.isSearchingMAM).toBe(false)
      expect(state.mamError).toBe('Server error')
    })

    it('should reset MAM results when query changes', () => {
      searchStore.setState({
        query: 'old',
        mamResults: [{ indexId: 'mam:1', messageId: 'm1', conversationId: 'x', conversationName: 'X', isRoom: false, from: 'y', timestamp: 0, body: 'z', matchSnippet: null, source: 'mam' as const }],
        hasMoreMAMResults: true,
      })

      searchStore.getState().search('new query')

      const state = searchStore.getState()
      expect(state.mamResults).toEqual([])
      expect(state.hasMoreMAMResults).toBe(false)
    })
  })

  // ===========================================================================
  // search with scope (local search filtering)
  // ===========================================================================

  describe('search with scope', () => {
    it('should include source field in local results', async () => {
      const mockResults: SearchIndexResult[] = [
        {
          indexId: 'chat:msg-1',
          messageId: 'msg-1',
          conversationId: 'alice@example.com',
          from: 'alice@example.com',
          timestamp: Date.now(),
          isRoom: false,
          body: 'Hello from Alice',
        },
      ]
      vi.mocked(searchIndex.search).mockResolvedValueOnce(mockResults)

      searchStore.getState().search('hello')
      vi.advanceTimersByTime(300)
      await vi.runAllTimersAsync()

      const state = searchStore.getState()
      expect(state.results[0].source).toBe('local')
    })
  })

  // ===========================================================================
  // searchFilter
  // ===========================================================================

  describe('searchFilter', () => {
    it('should default to all', () => {
      expect(searchStore.getState().searchFilter).toBe('all')
    })

    it('should update searchFilter when setSearchFilter is called', () => {
      searchStore.getState().setSearchFilter('conversations')
      expect(searchStore.getState().searchFilter).toBe('conversations')
    })

    it('should pass isRoom:false to searchIndex when filter is conversations', async () => {
      searchStore.setState({ query: 'hello' })
      searchStore.getState().setSearchFilter('conversations')
      await vi.runAllTimersAsync()

      expect(searchIndex.search).toHaveBeenCalledWith('hello', expect.objectContaining({
        isRoom: false,
      }))
    })

    it('should pass isRoom:true to searchIndex when filter is rooms', async () => {
      searchStore.setState({ query: 'hello' })
      searchStore.getState().setSearchFilter('rooms')
      await vi.runAllTimersAsync()

      expect(searchIndex.search).toHaveBeenCalledWith('hello', expect.objectContaining({
        isRoom: true,
      }))
    })

    it('should not pass isRoom to searchIndex when filter is all', async () => {
      searchStore.setState({ query: 'hello' })
      searchStore.getState().setSearchFilter('all')
      await vi.runAllTimersAsync()

      expect(searchIndex.search).toHaveBeenCalledWith('hello', expect.not.objectContaining({
        isRoom: expect.anything(),
      }))
    })

    it('should re-run search when filter changes with active query', () => {
      searchStore.setState({ query: 'hello' })

      searchStore.getState().setSearchFilter('rooms')

      expect(searchStore.getState().isSearching).toBe(true)
    })

    it('should not re-run search when filter changes without a query', () => {
      searchStore.setState({ query: '' })

      searchStore.getState().setSearchFilter('rooms')

      expect(searchStore.getState().isSearching).toBe(false)
    })

    it('should reset filter to all on clearSearch', () => {
      searchStore.setState({ searchFilter: 'rooms' })

      searchStore.getState().clearSearch()

      expect(searchStore.getState().searchFilter).toBe('all')
    })

    it('should reset filter to all when query is cleared', () => {
      searchStore.setState({ searchFilter: 'rooms', query: 'hello' })

      searchStore.getState().search('')

      expect(searchStore.getState().searchFilter).toBe('all')
    })

    it('should clear results when filter changes', () => {
      searchStore.setState({
        results: [{ indexId: 'x', messageId: 'x', conversationId: 'y', conversationName: 'Y', isRoom: false, from: 'z', timestamp: 0, body: 'w', matchSnippet: null, source: 'local' as const }],
        mamResults: [{ indexId: 'mam:x', messageId: 'x2', conversationId: 'y', conversationName: 'Y', isRoom: true, from: 'z', timestamp: 0, body: 'w', matchSnippet: null, source: 'mam' as const }],
      })

      searchStore.getState().setSearchFilter('conversations')

      const state = searchStore.getState()
      expect(state.results).toEqual([])
      expect(state.mamResults).toEqual([])
    })
  })

  // ===========================================================================
  // in: prefix
  // ===========================================================================

  describe('in: prefix', () => {
    describe('parseInPrefix', () => {
      it('should return null for non-prefixed query', () => {
        expect(parseInPrefix('hello')).toBeNull()
      })

      it('should parse in: with term', () => {
        expect(parseInPrefix('in:alice')).toEqual({ inTerm: 'alice', rest: '' })
      })

      it('should parse in: with term and rest', () => {
        expect(parseInPrefix('in:Alice hello world')).toEqual({ inTerm: 'Alice', rest: 'hello world' })
      })

      it('should handle empty in:', () => {
        expect(parseInPrefix('in:')).toEqual({ inTerm: '', rest: '' })
      })

      it('should not match in: in the middle of query', () => {
        expect(parseInPrefix('hello in:alice')).toBeNull()
      })
    })

    describe('getInPrefixSuggestions', () => {
      beforeEach(() => {
        // roomStore needs rooms set up for suggestions
        roomStore.setState({
          rooms: new Map([
            ['dev@conference.example.com', { jid: 'dev@conference.example.com', name: 'Dev Team', joined: true } as any],
            ['general@conference.example.com', { jid: 'general@conference.example.com', name: 'General', joined: true } as any],
          ]),
        })
      })

      it('should return empty for empty term', () => {
        expect(getInPrefixSuggestions('')).toEqual([])
      })

      it('should match conversations by name', () => {
        const results = getInPrefixSuggestions('ali')
        expect(results).toHaveLength(1)
        expect(results[0]).toEqual({ id: 'alice@example.com', name: 'Alice', isRoom: false })
      })

      it('should match rooms by name', () => {
        const results = getInPrefixSuggestions('dev')
        expect(results).toHaveLength(1)
        expect(results[0]).toEqual({ id: 'dev@conference.example.com', name: 'Dev Team', isRoom: true })
      })

      it('should match by JID', () => {
        const results = getInPrefixSuggestions('bob@')
        expect(results).toHaveLength(1)
        expect(results[0].id).toBe('bob@example.com')
      })

      it('should return both conversations and rooms', () => {
        // 'al' matches Alice, 'general' matches General room — test case-insensitive
        const results = getInPrefixSuggestions('e') // matches alice, bob, dev, general (all contain 'e')
        expect(results.length).toBeGreaterThan(1)
        const hasChat = results.some(r => !r.isRoom)
        const hasRoom = results.some(r => r.isRoom)
        expect(hasChat).toBe(true)
        expect(hasRoom).toBe(true)
      })
    })

    describe('search with in: prefix', () => {
      beforeEach(() => {
        roomStore.setState({
          rooms: new Map([
            ['dev@conference.example.com', { jid: 'dev@conference.example.com', name: 'Dev Team', joined: true } as any],
          ]),
        })
      })

      it('should activate in-prefix mode when query starts with in:', () => {
        searchStore.getState().search('in:ali')

        const state = searchStore.getState()
        expect(state.isInPrefixActive).toBe(true)
        expect(state.inPrefixSuggestions).toHaveLength(1)
        expect(state.inPrefixSuggestions[0].name).toBe('Alice')
      })

      it('should not trigger search index when in-prefix mode is active without rest', () => {
        searchStore.getState().search('in:ali')
        vi.advanceTimersByTime(300)

        expect(searchIndex.search).not.toHaveBeenCalled()
      })

      it('should clear in-prefix state for normal queries', () => {
        searchStore.setState({ isInPrefixActive: true, inPrefixSuggestions: [{ id: 'x', name: 'X', isRoom: false }] })

        searchStore.getState().search('hello')

        const state = searchStore.getState()
        expect(state.isInPrefixActive).toBe(false)
        expect(state.inPrefixSuggestions).toEqual([])
      })
    })

    describe('selectInPrefixSuggestion', () => {
      it('should set scope and clear in-prefix state', () => {
        searchStore.setState({ query: 'in:alice', isInPrefixActive: true })

        searchStore.getState().selectInPrefixSuggestion({ id: 'alice@example.com', name: 'Alice', isRoom: false })

        const state = searchStore.getState()
        expect(state.searchScope).toBe('alice@example.com')
        expect(state.isInPrefixActive).toBe(false)
        expect(state.inPrefixSuggestions).toEqual([])
      })

      it('should update query to rest and trigger search', () => {
        searchStore.setState({ query: 'in:alice hello world', isInPrefixActive: true })

        searchStore.getState().selectInPrefixSuggestion({ id: 'alice@example.com', name: 'Alice', isRoom: false })

        const state = searchStore.getState()
        expect(state.query).toBe('hello world')
        expect(state.searchScope).toBe('alice@example.com')
        expect(state.isSearching).toBe(true)
      })

      it('should not trigger search when no rest query', () => {
        searchStore.setState({ query: 'in:alice', isInPrefixActive: true })

        searchStore.getState().selectInPrefixSuggestion({ id: 'alice@example.com', name: 'Alice', isRoom: false })

        const state = searchStore.getState()
        expect(state.query).toBe('')
        expect(state.isSearching).toBe(false)
      })
    })

    it('should reset in-prefix state on clearSearch', () => {
      searchStore.setState({
        isInPrefixActive: true,
        inPrefixSuggestions: [{ id: 'x', name: 'X', isRoom: false }],
      })

      searchStore.getState().clearSearch()

      const state = searchStore.getState()
      expect(state.isInPrefixActive).toBe(false)
      expect(state.inPrefixSuggestions).toEqual([])
    })
  })
})

// ===========================================================================
// Helper: create a mock MAM client for searchStore tests
// ===========================================================================

function createMockMAMClient(opts?: {
  searchArchiveResults?: Array<{ id: string; conversationId: string; from: string; body: string; timestamp: Date }>
}) {
  const results = opts?.searchArchiveResults ?? []
  return {
    mam: {
      searchArchive: vi.fn().mockResolvedValue({
        messages: results.map(r => ({
          id: r.id,
          conversationId: r.conversationId,
          from: r.from,
          body: r.body,
          timestamp: r.timestamp,
          isOutgoing: false,
          isDelayed: true,
        })),
        complete: true,
        rsm: {},
      }),
      searchRoomArchive: vi.fn().mockResolvedValue({
        messages: [],
        complete: true,
        rsm: {},
      }),
      searchConversationByPaging: vi.fn().mockResolvedValue({
        messages: [],
        complete: true,
        rsm: {},
      }),
    },
  }
}
