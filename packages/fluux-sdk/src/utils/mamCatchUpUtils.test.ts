import { describe, it, expect } from 'vitest'
import {
  findNewestMessage,
  buildCatchUpStartTime,
  isConnectionError,
  MAM_CATCHUP_FORWARD_MAX,
  MAM_CATCHUP_BACKWARD_MAX,
  MAM_BACKGROUND_CONCURRENCY,
  MAM_CACHE_LOAD_LIMIT,
  MAM_ROOM_CATCHUP_DELAY_MS,
  MAM_ROOM_FORWARD_MAX_PAGES,
} from './mamCatchUpUtils'

// ============================================================================
// findNewestMessage
// ============================================================================

describe('findNewestMessage', () => {
  it('returns undefined for an empty array', () => {
    expect(findNewestMessage([])).toBeUndefined()
  })

  it('returns undefined when no messages have timestamps', () => {
    expect(findNewestMessage([{}, {}, {}])).toBeUndefined()
  })

  it('returns the single message when only one has a timestamp', () => {
    const ts = new Date('2025-01-15T10:00:00Z')
    const result = findNewestMessage([{}, { timestamp: ts }, {}])
    expect(result).toEqual({ timestamp: ts })
  })

  it('returns the last message with a timestamp (walking backwards)', () => {
    const older = new Date('2025-01-01T00:00:00Z')
    const newer = new Date('2025-01-15T12:00:00Z')
    const messages = [
      { timestamp: older },
      { timestamp: newer },
      {}, // no timestamp — skipped
    ]
    const result = findNewestMessage(messages)
    expect(result?.timestamp).toBe(newer)
  })

  it('works with a single-element array', () => {
    const ts = new Date()
    expect(findNewestMessage([{ timestamp: ts }])).toEqual({ timestamp: ts })
  })

  it('works when all messages are delayed (all have timestamps)', () => {
    const t1 = new Date('2025-01-01T00:00:00Z')
    const t2 = new Date('2025-01-02T00:00:00Z')
    const t3 = new Date('2025-01-03T00:00:00Z')
    const result = findNewestMessage([
      { timestamp: t1 },
      { timestamp: t2 },
      { timestamp: t3 },
    ])
    expect(result?.timestamp).toBe(t3)
  })
})

// ============================================================================
// buildCatchUpStartTime
// ============================================================================

describe('buildCatchUpStartTime', () => {
  it('returns an ISO string offset by +1 ms', () => {
    const base = new Date('2025-06-15T08:30:00.000Z')
    const result = buildCatchUpStartTime(base)
    expect(result).toBe('2025-06-15T08:30:00.001Z')
  })

  it('handles millisecond rollover correctly', () => {
    const base = new Date('2025-06-15T08:30:00.999Z')
    const result = buildCatchUpStartTime(base)
    expect(result).toBe('2025-06-15T08:30:01.000Z')
  })

  it('does not mutate the input date', () => {
    const base = new Date('2025-01-01T00:00:00.000Z')
    const originalTime = base.getTime()
    buildCatchUpStartTime(base)
    expect(base.getTime()).toBe(originalTime)
  })
})

// ============================================================================
// isConnectionError
// ============================================================================

describe('isConnectionError', () => {
  it('returns true for "disconnected" errors', () => {
    expect(isConnectionError(new Error('Client disconnected'))).toBe(true)
  })

  it('returns true for "Not connected" errors', () => {
    expect(isConnectionError(new Error('Not connected'))).toBe(true)
  })

  it('returns true for "Socket not available" errors', () => {
    expect(isConnectionError(new Error('Socket not available'))).toBe(true)
  })

  it('returns false for non-Error values', () => {
    expect(isConnectionError('disconnected')).toBe(false)
    expect(isConnectionError(null)).toBe(false)
    expect(isConnectionError(undefined)).toBe(false)
    expect(isConnectionError(42)).toBe(false)
  })

  it('returns false for unrelated errors', () => {
    expect(isConnectionError(new Error('timeout'))).toBe(false)
    expect(isConnectionError(new Error('item-not-found'))).toBe(false)
  })
})

// ============================================================================
// Constants sanity check
// ============================================================================

describe('MAM constants', () => {
  it('exports expected values', () => {
    expect(MAM_CATCHUP_FORWARD_MAX).toBe(100)
    expect(MAM_CATCHUP_BACKWARD_MAX).toBe(50)
    expect(MAM_BACKGROUND_CONCURRENCY).toBe(2)
    expect(MAM_CACHE_LOAD_LIMIT).toBe(100)
    expect(MAM_ROOM_CATCHUP_DELAY_MS).toBe(10_000)
    expect(MAM_ROOM_FORWARD_MAX_PAGES).toBe(50)
  })
})
