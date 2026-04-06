import { describe, it, expect } from 'vitest'
import {
  DEFAULT_MAM_STATE,
  getMAMQueryState,
  setMAMLoading,
  setMAMError,
  setMAMQueryCompleted,
  markAllNeedsCatchUp,
  clearNeedsCatchUp,
} from './mamState'
import type { MAMQueryState } from '../../core/types'

describe('mamState utilities', () => {
  describe('DEFAULT_MAM_STATE', () => {
    it('has correct default values', () => {
      expect(DEFAULT_MAM_STATE).toEqual({
        isLoading: false,
        error: null,
        hasQueried: false,
        isHistoryComplete: false,
        isCaughtUpToLive: false,
      })
    })
  })

  describe('getMAMQueryState', () => {
    it('returns default state when id not found', () => {
      const states = new Map<string, MAMQueryState>()
      const result = getMAMQueryState(states, 'unknown-id')
      expect(result).toEqual(DEFAULT_MAM_STATE)
    })

    it('returns existing state when id is found', () => {
      const existingState: MAMQueryState = {
        isLoading: true,
        error: null,
        hasQueried: true,
        isHistoryComplete: false,
        isCaughtUpToLive: false,
        oldestFetchedId: 'msg-123',
      }
      const states = new Map<string, MAMQueryState>([['conv-1', existingState]])
      const result = getMAMQueryState(states, 'conv-1')
      expect(result).toEqual(existingState)
    })
  })

  describe('setMAMLoading', () => {
    it('creates new state with loading=true for new id', () => {
      const states = new Map<string, MAMQueryState>()
      const result = setMAMLoading(states, 'conv-1', true)

      expect(result.get('conv-1')).toEqual({
        ...DEFAULT_MAM_STATE,
        isLoading: true,
      })
      // Original map should be unchanged
      expect(states.has('conv-1')).toBe(false)
    })

    it('updates existing state with loading=true', () => {
      const existingState: MAMQueryState = {
        isLoading: false,
        error: 'previous error',
        hasQueried: true,
        isHistoryComplete: false,
        isCaughtUpToLive: false,
        oldestFetchedId: 'msg-123',
      }
      const states = new Map<string, MAMQueryState>([['conv-1', existingState]])
      const result = setMAMLoading(states, 'conv-1', true)

      expect(result.get('conv-1')).toEqual({
        ...existingState,
        isLoading: true,
      })
    })

    it('sets loading=false', () => {
      const existingState: MAMQueryState = {
        isLoading: true,
        error: null,
        hasQueried: false,
        isHistoryComplete: false,
        isCaughtUpToLive: false,
      }
      const states = new Map<string, MAMQueryState>([['conv-1', existingState]])
      const result = setMAMLoading(states, 'conv-1', false)

      expect(result.get('conv-1')?.isLoading).toBe(false)
    })

    it('does not mutate the original map', () => {
      const states = new Map<string, MAMQueryState>()
      const result = setMAMLoading(states, 'conv-1', true)

      expect(result).not.toBe(states)
      expect(states.size).toBe(0)
    })
  })

  describe('setMAMError', () => {
    it('sets error and clears loading state', () => {
      const existingState: MAMQueryState = {
        isLoading: true,
        error: null,
        hasQueried: false,
        isHistoryComplete: false,
        isCaughtUpToLive: false,
      }
      const states = new Map<string, MAMQueryState>([['conv-1', existingState]])
      const result = setMAMError(states, 'conv-1', 'Network error')

      expect(result.get('conv-1')).toEqual({
        ...existingState,
        isLoading: false,
        error: 'Network error',
      })
    })

    it('clears error when set to null', () => {
      const existingState: MAMQueryState = {
        isLoading: false,
        error: 'Previous error',
        hasQueried: true,
        isHistoryComplete: false,
        isCaughtUpToLive: false,
      }
      const states = new Map<string, MAMQueryState>([['conv-1', existingState]])
      const result = setMAMError(states, 'conv-1', null)

      expect(result.get('conv-1')?.error).toBeNull()
    })

    it('creates new state for unknown id', () => {
      const states = new Map<string, MAMQueryState>()
      const result = setMAMError(states, 'conv-1', 'Error')

      expect(result.get('conv-1')).toEqual({
        ...DEFAULT_MAM_STATE,
        error: 'Error',
        isLoading: false,
      })
    })

    it('does not mutate the original map', () => {
      const states = new Map<string, MAMQueryState>()
      const result = setMAMError(states, 'conv-1', 'Error')

      expect(result).not.toBe(states)
      expect(states.size).toBe(0)
    })
  })

  describe('setMAMQueryCompleted', () => {
    it('sets completed state with oldestFetchedId for backward query', () => {
      const states = new Map<string, MAMQueryState>()
      const result = setMAMQueryCompleted(states, 'conv-1', true, 'backward', 'msg-oldest')

      expect(result.get('conv-1')).toEqual({
        isLoading: false,
        error: null,
        hasQueried: true,
        isHistoryComplete: true,
        isCaughtUpToLive: false,
        oldestFetchedId: 'msg-oldest',
        needsCatchUp: false,
        forwardGapTimestamp: undefined,
      })
    })

    it('sets isCaughtUpToLive for forward query', () => {
      const states = new Map<string, MAMQueryState>()
      const result = setMAMQueryCompleted(states, 'conv-1', true, 'forward', 'msg-newest')

      expect(result.get('conv-1')).toEqual({
        isLoading: false,
        error: null,
        hasQueried: true,
        isHistoryComplete: false,
        isCaughtUpToLive: true,
        oldestFetchedId: undefined, // Not updated for forward queries
        needsCatchUp: false,
        forwardGapTimestamp: undefined, // Cleared when caught up
      })
    })

    it('sets isHistoryComplete=false for incomplete backward query', () => {
      const states = new Map<string, MAMQueryState>()
      const result = setMAMQueryCompleted(states, 'conv-1', false, 'backward', 'msg-123')

      expect(result.get('conv-1')?.isHistoryComplete).toBe(false)
      expect(result.get('conv-1')?.hasQueried).toBe(true)
    })

    it('handles undefined oldestFetchedId', () => {
      const states = new Map<string, MAMQueryState>()
      const result = setMAMQueryCompleted(states, 'conv-1', true, 'backward')

      expect(result.get('conv-1')?.oldestFetchedId).toBeUndefined()
    })

    it('does not mutate the original map', () => {
      const states = new Map<string, MAMQueryState>()
      const result = setMAMQueryCompleted(states, 'conv-1', true, 'backward', 'msg-123')

      expect(result).not.toBe(states)
      expect(states.size).toBe(0)
    })

    it('preserves existing isHistoryComplete when doing forward query', () => {
      const states = new Map<string, MAMQueryState>()
      // First, complete backward history
      const afterBackward = setMAMQueryCompleted(states, 'conv-1', true, 'backward', 'msg-oldest')
      expect(afterBackward.get('conv-1')?.isHistoryComplete).toBe(true)

      // Now do a forward query
      const afterForward = setMAMQueryCompleted(afterBackward, 'conv-1', true, 'forward')
      expect(afterForward.get('conv-1')?.isHistoryComplete).toBe(true) // Preserved
      expect(afterForward.get('conv-1')?.isCaughtUpToLive).toBe(true) // Updated
    })

    it('preserves existing isCaughtUpToLive when doing backward query', () => {
      const states = new Map<string, MAMQueryState>()
      // First, catch up to live
      const afterForward = setMAMQueryCompleted(states, 'conv-1', true, 'forward')
      expect(afterForward.get('conv-1')?.isCaughtUpToLive).toBe(true)

      // Now do a backward query
      const afterBackward = setMAMQueryCompleted(afterForward, 'conv-1', true, 'backward', 'msg-oldest')
      expect(afterBackward.get('conv-1')?.isCaughtUpToLive).toBe(true) // Preserved
      expect(afterBackward.get('conv-1')?.isHistoryComplete).toBe(true) // Updated
    })

    it('sets forwardGapTimestamp when forward catch-up is incomplete', () => {
      const states = new Map<string, MAMQueryState>()
      const gapTs = Date.now() - 60_000
      const result = setMAMQueryCompleted(states, 'room-1', false, 'forward', undefined, gapTs)

      expect(result.get('room-1')?.forwardGapTimestamp).toBe(gapTs)
      expect(result.get('room-1')?.isCaughtUpToLive).toBe(false)
    })

    it('clears forwardGapTimestamp when forward catch-up completes', () => {
      const states = new Map<string, MAMQueryState>()
      // First: incomplete catch-up sets the gap
      const withGap = setMAMQueryCompleted(states, 'room-1', false, 'forward', undefined, Date.now())
      expect(withGap.get('room-1')?.forwardGapTimestamp).toBeDefined()

      // Second: complete catch-up clears the gap
      const cleared = setMAMQueryCompleted(withGap, 'room-1', true, 'forward', undefined, Date.now())
      expect(cleared.get('room-1')?.forwardGapTimestamp).toBeUndefined()
      expect(cleared.get('room-1')?.isCaughtUpToLive).toBe(true)
    })

    it('preserves forwardGapTimestamp during backward queries', () => {
      const states = new Map<string, MAMQueryState>()
      const gapTs = Date.now() - 60_000
      const withGap = setMAMQueryCompleted(states, 'room-1', false, 'forward', undefined, gapTs)

      // Backward query should not touch the gap timestamp
      const afterBackward = setMAMQueryCompleted(withGap, 'room-1', true, 'backward', 'msg-oldest')
      expect(afterBackward.get('room-1')?.forwardGapTimestamp).toBe(gapTs)
    })

    it('does not set forwardGapTimestamp when no timestamp is provided', () => {
      const states = new Map<string, MAMQueryState>()
      const result = setMAMQueryCompleted(states, 'room-1', false, 'forward')

      expect(result.get('room-1')?.forwardGapTimestamp).toBeUndefined()
      expect(result.get('room-1')?.isCaughtUpToLive).toBe(false)
    })
  })

  describe('markAllNeedsCatchUp', () => {
    it('marks all existing states as needing catch-up', () => {
      const states = new Map<string, MAMQueryState>()
      states.set('conv-1', { ...DEFAULT_MAM_STATE, hasQueried: true })
      states.set('conv-2', { ...DEFAULT_MAM_STATE, hasQueried: true })

      const result = markAllNeedsCatchUp(states)

      expect(result.get('conv-1')?.needsCatchUp).toBe(true)
      expect(result.get('conv-2')?.needsCatchUp).toBe(true)
    })

    it('returns empty map when given empty map', () => {
      const states = new Map<string, MAMQueryState>()
      const result = markAllNeedsCatchUp(states)
      expect(result.size).toBe(0)
    })

    it('does not mutate the original map', () => {
      const states = new Map<string, MAMQueryState>()
      states.set('conv-1', { ...DEFAULT_MAM_STATE })

      const result = markAllNeedsCatchUp(states)

      expect(result).not.toBe(states)
      expect(states.get('conv-1')?.needsCatchUp).toBeUndefined()
    })
  })

  describe('clearNeedsCatchUp', () => {
    it('clears needsCatchUp flag for specific conversation', () => {
      const states = new Map<string, MAMQueryState>()
      states.set('conv-1', { ...DEFAULT_MAM_STATE, needsCatchUp: true })
      states.set('conv-2', { ...DEFAULT_MAM_STATE, needsCatchUp: true })

      const result = clearNeedsCatchUp(states, 'conv-1')

      expect(result.get('conv-1')?.needsCatchUp).toBe(false)
      expect(result.get('conv-2')?.needsCatchUp).toBe(true) // Unchanged
    })

    it('returns original map when conversation not found', () => {
      const states = new Map<string, MAMQueryState>()
      states.set('conv-1', { ...DEFAULT_MAM_STATE })

      const result = clearNeedsCatchUp(states, 'unknown')

      expect(result).toBe(states) // Same reference
    })

    it('returns original map when needsCatchUp is already false', () => {
      const states = new Map<string, MAMQueryState>()
      states.set('conv-1', { ...DEFAULT_MAM_STATE, needsCatchUp: false })

      const result = clearNeedsCatchUp(states, 'conv-1')

      expect(result).toBe(states) // Same reference
    })
  })
})
