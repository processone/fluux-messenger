import { describe, it, expect } from 'vitest'
import {
  DEFAULT_MAM_STATE,
  getMAMQueryState,
  setMAMLoading,
  setMAMError,
  setMAMQueryCompleted,
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
        forwardGapTimestamp: undefined, // Cleared when caught up
      })
    })

    it('clears an existing forwardGapTimestamp on a completing forward query (default)', () => {
      const states = new Map<string, MAMQueryState>([
        ['room-1', { ...DEFAULT_MAM_STATE, forwardGapTimestamp: 1000 }],
      ])
      const result = setMAMQueryCompleted(states, 'room-1', true, 'forward')
      expect(result.get('room-1')?.forwardGapTimestamp).toBeUndefined()
    })

    it('preserveGapMarker keeps an existing forwardGapTimestamp on a completing forward query', () => {
      // A bounded force repair must NOT hide a real gap marker just because its
      // own (windowed) forward query happened to complete.
      const states = new Map<string, MAMQueryState>([
        ['room-1', { ...DEFAULT_MAM_STATE, forwardGapTimestamp: 1000 }],
      ])
      const result = setMAMQueryCompleted(states, 'room-1', true, 'forward', undefined, undefined, true)
      expect(result.get('room-1')?.forwardGapTimestamp).toBe(1000)
      expect(result.get('room-1')?.isCaughtUpToLive).toBe(true) // other markers still update
    })

    it('preserveGapMarker does not overwrite forwardGapTimestamp on an incomplete forward query', () => {
      const states = new Map<string, MAMQueryState>([
        ['room-1', { ...DEFAULT_MAM_STATE, forwardGapTimestamp: 1000 }],
      ])
      // Without preserve this would set forwardGapTimestamp = 5000 (this page's newest).
      const result = setMAMQueryCompleted(states, 'room-1', false, 'forward', undefined, 5000, true)
      expect(result.get('room-1')?.forwardGapTimestamp).toBe(1000)
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

    it('preserves the existing forwardGapTimestamp on an incomplete forward page with no fetched timestamp (signal-only page)', () => {
      // A signal-only page (reactions/receipts only — zero displayable
      // messages) yields no newestFetchedTimestamp. It proves nothing about
      // the hole, so it must not erase the recorded marker.
      const states = new Map<string, MAMQueryState>([
        ['room-1', { ...DEFAULT_MAM_STATE, forwardGapTimestamp: 1000 }],
      ])
      const result = setMAMQueryCompleted(states, 'room-1', false, 'forward', undefined, undefined)

      expect(result.get('room-1')?.forwardGapTimestamp).toBe(1000)
      expect(result.get('room-1')?.isCaughtUpToLive).toBe(false)
    })
  })

  describe('setMAMQueryCompleted fetch-latest', () => {
    it('marks caught-up-to-live on a fetch-latest merge (window is at the live edge by definition)', () => {
      const states = setMAMQueryCompleted(new Map(), 'a@b.c', false, 'backward', undefined, undefined, false, true)
      expect(states.get('a@b.c')?.isCaughtUpToLive).toBe(true)
    })

    it('plain backward completion still does not mark caught-up-to-live', () => {
      const states = setMAMQueryCompleted(new Map(), 'a@b.c', true, 'backward')
      expect(states.get('a@b.c')?.isCaughtUpToLive).toBe(false)
    })
  })

})
