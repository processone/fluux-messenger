import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFetchOlderHistory, type FetchOlderHistoryDeps } from './createFetchOlderHistory'
import type { MAMQueryState } from '../../core/types'
import { connectionStore } from '../../stores'

// Mock the connection store to return 'online' status
vi.mock('../../stores', () => ({
  connectionStore: {
    getState: vi.fn(() => ({ status: 'online' })),
  },
}))

describe('createFetchOlderHistory', () => {
  let deps: FetchOlderHistoryDeps
  let fetchOlderHistory: (targetId?: string) => Promise<void>

  beforeEach(() => {
    // Reset connection mock to online status
    vi.mocked(connectionStore.getState).mockReturnValue({ status: 'online' } as ReturnType<typeof connectionStore.getState>)

    deps = {
      getActiveId: vi.fn(() => 'conv-1'),
      isValidTarget: vi.fn(() => true),
      getMAMState: vi.fn((): MAMQueryState => ({
        isLoading: false,
        hasQueried: true,
        isHistoryComplete: false,
        isCaughtUpToLive: false,
        error: null,
        oldestFetchedId: 'mam-oldest', // Note: this is no longer used for pagination
      })),
      setMAMLoading: vi.fn(),
      loadFromCache: vi.fn(() => Promise.resolve([])),
      getOldestMessageId: vi.fn(() => 'msg-oldest-stanza-id'),
      queryMAM: vi.fn(() => Promise.resolve()),
      errorLogPrefix: 'Failed to fetch older history',
    }
    fetchOlderHistory = createFetchOlderHistory(deps)
  })

  describe('target resolution', () => {
    it('uses provided targetId when given', async () => {
      await fetchOlderHistory('conv-2')

      expect(deps.isValidTarget).toHaveBeenCalledWith('conv-2')
      expect(deps.getActiveId).not.toHaveBeenCalled()
    })

    it('falls back to getActiveId when no targetId provided', async () => {
      await fetchOlderHistory()

      expect(deps.getActiveId).toHaveBeenCalled()
      expect(deps.isValidTarget).toHaveBeenCalledWith('conv-1')
    })

    it('returns early when no active ID and no targetId', async () => {
      vi.mocked(deps.getActiveId).mockReturnValue(null)

      await fetchOlderHistory()

      expect(deps.isValidTarget).not.toHaveBeenCalled()
      expect(deps.setMAMLoading).not.toHaveBeenCalled()
    })
  })

  describe('validation', () => {
    it('returns early when target is not valid', async () => {
      vi.mocked(deps.isValidTarget).mockReturnValue(false)

      await fetchOlderHistory('conv-1')

      expect(deps.setMAMLoading).not.toHaveBeenCalled()
      expect(deps.loadFromCache).not.toHaveBeenCalled()
    })
  })

  describe('MAM state checks', () => {
    it('returns early when MAM is already loading', async () => {
      vi.mocked(deps.getMAMState).mockReturnValue({
        isLoading: true,
        hasQueried: false,
        isHistoryComplete: false,
        isCaughtUpToLive: false,
        error: null,
      })

      await fetchOlderHistory('conv-1')

      expect(deps.setMAMLoading).not.toHaveBeenCalled()
      expect(deps.loadFromCache).not.toHaveBeenCalled()
    })

    it('does not query MAM when already complete and cache is empty', async () => {
      vi.mocked(deps.getMAMState).mockReturnValue({
        isLoading: false,
        hasQueried: true,
        isHistoryComplete: true,
        isCaughtUpToLive: false,
        error: null,
        oldestFetchedId: 'msg-oldest',
      })
      vi.mocked(deps.loadFromCache).mockResolvedValue([])

      await fetchOlderHistory('conv-1')

      expect(deps.loadFromCache).toHaveBeenCalled()
      expect(deps.queryMAM).not.toHaveBeenCalled()
    })
  })

  describe('cache loading', () => {
    it('sets loading state before loading from cache', async () => {
      await fetchOlderHistory('conv-1')

      expect(deps.setMAMLoading).toHaveBeenCalledWith('conv-1', true)
      expect(deps.loadFromCache).toHaveBeenCalledWith('conv-1', 50)
    })

    it('returns early without querying MAM when cache has messages', async () => {
      vi.mocked(deps.loadFromCache).mockResolvedValue([{ id: 'msg-1' }, { id: 'msg-2' }])

      await fetchOlderHistory('conv-1')

      expect(deps.queryMAM).not.toHaveBeenCalled()
    })

    it('clears loading state after cache returns messages', async () => {
      vi.mocked(deps.loadFromCache).mockResolvedValue([{ id: 'msg-1' }])

      await fetchOlderHistory('conv-1')

      expect(deps.setMAMLoading).toHaveBeenCalledWith('conv-1', false)
    })
  })

  describe('MAM fallback', () => {
    it('queries MAM when cache is empty using oldest in-memory message ID', async () => {
      vi.mocked(deps.loadFromCache).mockResolvedValue([])

      await fetchOlderHistory('conv-1')

      // Should use getOldestMessageId result, not mamState.oldestFetchedId
      expect(deps.getOldestMessageId).toHaveBeenCalledWith('conv-1')
      expect(deps.queryMAM).toHaveBeenCalledWith('conv-1', 'msg-oldest-stanza-id')
    })

    it('uses empty string for room MAM when no oldest message ID', async () => {
      deps.errorLogPrefix = 'Failed to fetch older room history'
      vi.mocked(deps.getOldestMessageId).mockReturnValue(undefined)
      fetchOlderHistory = createFetchOlderHistory(deps)
      vi.mocked(deps.loadFromCache).mockResolvedValue([])

      await fetchOlderHistory('room-1')

      // Room MAM allows empty string (means "get latest")
      expect(deps.queryMAM).toHaveBeenCalledWith('room-1', '')
    })

    it('skips MAM query for chat when no oldest message ID', async () => {
      deps.errorLogPrefix = 'Failed to fetch older chat history'
      vi.mocked(deps.getOldestMessageId).mockReturnValue(undefined)
      fetchOlderHistory = createFetchOlderHistory(deps)
      vi.mocked(deps.loadFromCache).mockResolvedValue([])

      await fetchOlderHistory('conv-1')

      // Chat MAM requires a valid cursor to paginate backwards
      expect(deps.queryMAM).not.toHaveBeenCalled()
    })

    it('uses in-memory message ID even when MAM state has different oldestFetchedId', async () => {
      // This tests the fix: after initial MAM query with 'start' filter,
      // mamState.oldestFetchedId contains the oldest NEW message, but we
      // need to use the oldest IN-MEMORY message for pagination
      vi.mocked(deps.getMAMState).mockReturnValue({
        isLoading: false,
        hasQueried: true,
        isHistoryComplete: false,
        isCaughtUpToLive: false,
        error: null,
        oldestFetchedId: 'mam-oldest-from-start-query', // From initial 'fetch new' query
      })
      vi.mocked(deps.getOldestMessageId).mockReturnValue('cached-oldest-msg') // From IndexedDB cache
      vi.mocked(deps.loadFromCache).mockResolvedValue([])

      await fetchOlderHistory('conv-1')

      // Should use the in-memory oldest, not MAM state's oldestFetchedId
      expect(deps.queryMAM).toHaveBeenCalledWith('conv-1', 'cached-oldest-msg')
    })
  })

  describe('error handling', () => {
    it('logs error when cache loading fails', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.mocked(deps.loadFromCache).mockRejectedValue(new Error('Cache error'))

      await fetchOlderHistory('conv-1')

      expect(consoleSpy).toHaveBeenCalledWith('Failed to fetch older history:', expect.any(Error))
      consoleSpy.mockRestore()
    })

    it('logs error when MAM query fails', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.mocked(deps.loadFromCache).mockResolvedValue([])
      vi.mocked(deps.queryMAM).mockRejectedValue(new Error('MAM error'))

      await fetchOlderHistory('conv-1')

      expect(consoleSpy).toHaveBeenCalledWith('Failed to fetch older history:', expect.any(Error))
      consoleSpy.mockRestore()
    })

    it('clears loading state even when error occurs', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.mocked(deps.loadFromCache).mockRejectedValue(new Error('Error'))

      await fetchOlderHistory('conv-1')

      expect(deps.setMAMLoading).toHaveBeenLastCalledWith('conv-1', false)
      consoleSpy.mockRestore()
    })
  })

  describe('loading state management', () => {
    it('always clears loading state in finally block', async () => {
      await fetchOlderHistory('conv-1')

      const calls = vi.mocked(deps.setMAMLoading).mock.calls
      expect(calls[0]).toEqual(['conv-1', true])
      expect(calls[calls.length - 1]).toEqual(['conv-1', false])
    })
  })
})
