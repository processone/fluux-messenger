/**
 * Selector Stability Tests
 *
 * Zustand selectors used with useSyncExternalStore MUST return the same
 * reference when the underlying data hasn't changed. If a selector returns
 * a new object/array/Set/function on every call, Object.is comparison fails,
 * causing infinite re-render loops (React error #185).
 *
 * These tests verify that store methods used as selectors maintain referential
 * stability for their fallback/default values.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { roomStore, ignoreStore } from './index'

describe('Zustand selector referential stability', () => {
  beforeEach(() => {
    // Reset store state directly (avoid reset() which needs localStorage)
    roomStore.setState({ votedPollIds: new Map(), dismissedPollIds: new Map() })
  })

  describe('roomStore.getVotedPollIds', () => {
    it('returns the same reference for unknown room (stable empty Set)', () => {
      const result1 = roomStore.getState().getVotedPollIds('unknown@room')
      const result2 = roomStore.getState().getVotedPollIds('unknown@room')
      expect(result1).toBe(result2) // Same reference, not just equal
    })

    it('returns the same reference for different unknown rooms', () => {
      const result1 = roomStore.getState().getVotedPollIds('room-a@conf')
      const result2 = roomStore.getState().getVotedPollIds('room-b@conf')
      expect(result1).toBe(result2) // Both return the shared EMPTY_SET
    })

    it('returns actual data when votes exist', () => {
      roomStore.getState().recordPollVote('room@conf', 'poll-1')
      const result = roomStore.getState().getVotedPollIds('room@conf')
      expect(result.has('poll-1')).toBe(true)
    })
  })

  describe('roomStore.getDismissedPollIds', () => {
    it('returns the same reference for unknown room (stable empty Set)', () => {
      const result1 = roomStore.getState().getDismissedPollIds('unknown@room')
      const result2 = roomStore.getState().getDismissedPollIds('unknown@room')
      expect(result1).toBe(result2)
    })

    it('returns the same reference for different unknown rooms', () => {
      const result1 = roomStore.getState().getDismissedPollIds('room-a@conf')
      const result2 = roomStore.getState().getDismissedPollIds('room-b@conf')
      expect(result1).toBe(result2)
    })
  })

  describe('ignoreStore.getIgnoredForRoom', () => {
    it('returns the same reference for unknown room (stable empty array)', () => {
      const result1 = ignoreStore.getState().getIgnoredForRoom('unknown@room')
      const result2 = ignoreStore.getState().getIgnoredForRoom('unknown@room')
      expect(result1).toBe(result2)
    })

    it('returns the same reference for different unknown rooms', () => {
      const result1 = ignoreStore.getState().getIgnoredForRoom('room-a@conf')
      const result2 = ignoreStore.getState().getIgnoredForRoom('room-b@conf')
      expect(result1).toBe(result2)
    })

    // Data correctness tests are in ignoreStore's own test file.
    // Here we only verify referential stability of empty fallbacks.
  })

  describe('no selector should return a new closure', () => {
    // This pattern caused React error #185 in ActivityLogView:
    //   useRoomStore((s) => (jid: string) => s.rooms.has(jid))
    // The arrow function is a NEW closure on every call → infinite loop.
    //
    // This test documents the anti-pattern for future reference.
    it('demonstrates the anti-pattern: closure-returning selector is unstable', () => {
      const selector = (s: typeof roomStore extends { getState: () => infer S } ? S : never) =>
        (jid: string) => s.rooms.has(jid)

      const state = roomStore.getState()
      const fn1 = selector(state)
      const fn2 = selector(state)
      // Different function instances even with same state!
      expect(fn1).not.toBe(fn2)
    })
  })
})
