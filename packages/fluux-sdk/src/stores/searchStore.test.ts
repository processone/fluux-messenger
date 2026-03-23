import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { searchStore } from './searchStore'
import { chatStore } from './chatStore'
import { roomStore } from './roomStore'
import * as searchIndex from '../utils/searchIndex'
import type { SearchIndexResult } from '../utils/searchIndex'

// Mock the search index to avoid IDB dependency in store tests
vi.mock('../utils/searchIndex', () => ({
  search: vi.fn().mockResolvedValue([]),
  indexMessage: vi.fn().mockResolvedValue(undefined),
  indexMessages: vi.fn().mockResolvedValue(undefined),
  removeMessage: vi.fn().mockResolvedValue(undefined),
  updateMessage: vi.fn().mockResolvedValue(undefined),
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

    // Reset search store state
    searchStore.setState({
      query: '',
      isSearching: false,
      results: [],
      error: null,
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

    it('should trim whitespace from query', () => {
      searchStore.getState().search('  hello  ')

      expect(searchStore.getState().query).toBe('hello')
    })

    it('should clear results for empty query', () => {
      // Set some existing state
      searchStore.setState({
        query: 'old',
        results: [{ indexId: 'test', messageId: 'test', conversationId: 'x', conversationName: 'X', isRoom: false, from: 'y', timestamp: 0, body: 'z', matchSnippet: null }],
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
        results: [{ indexId: 'x', messageId: 'x', conversationId: 'y', conversationName: 'Y', isRoom: false, from: 'z', timestamp: 0, body: 'w', matchSnippet: null }],
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
  })
})
