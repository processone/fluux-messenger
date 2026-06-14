import { describe, it, expect } from 'vitest'
import {
  findNewestMessage,
  findCatchUpCursorMessage,
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
// findCatchUpCursorMessage
// ============================================================================

describe('findCatchUpCursorMessage', () => {
  const sessionStart = new Date('2026-06-14T12:00:00Z').getTime()

  it('returns undefined for an empty array', () => {
    expect(findCatchUpCursorMessage([], sessionStart)).toBeUndefined()
  })

  it('returns undefined when every message has no timestamp', () => {
    expect(findCatchUpCursorMessage([{}, {}], sessionStart)).toBeUndefined()
  })

  it('returns undefined when every message is from the current session (>= sessionStart)', () => {
    // Room first joined this session — only live messages, no prior history.
    const messages = [
      { timestamp: new Date('2026-06-14T12:00:05Z') },
      { timestamp: new Date('2026-06-14T12:00:10Z') },
    ]
    expect(findCatchUpCursorMessage(messages, sessionStart)).toBeUndefined()
  })

  it('returns the global newest when all messages predate the session (clean cold-start)', () => {
    const t1 = new Date('2026-05-01T00:00:00Z')
    const t2 = new Date('2026-05-14T09:00:00Z') // newest, still a month before sessionStart
    const messages = [{ timestamp: t1 }, { timestamp: t2 }]
    expect(findCatchUpCursorMessage(messages, sessionStart)?.timestamp).toBe(t2)
  })

  it('ignores live messages received this session and returns the newest PRE-session message', () => {
    // THE regression case: a live message lands in the catch-up window. The cursor
    // must be the month-old pre-session message, NOT the live one — otherwise the
    // forward query starts from "now" and silently skips the offline gap.
    const monthOld = new Date('2026-05-14T09:00:00Z')
    const liveDuringWindow = new Date('2026-06-14T12:00:05Z')
    const messages = [
      { timestamp: monthOld },
      { timestamp: liveDuringWindow }, // arrived after reconnect — must be excluded
    ]
    expect(findCatchUpCursorMessage(messages, sessionStart)?.timestamp).toBe(monthOld)
  })

  it('excludes a message exactly at sessionStart (strictly before)', () => {
    const atStart = new Date(sessionStart)
    const before = new Date(sessionStart - 1000)
    expect(findCatchUpCursorMessage([{ timestamp: before }, { timestamp: atStart }], sessionStart)?.timestamp).toBe(before)
  })

  it('returns the newest pre-session message regardless of array order', () => {
    const older = new Date('2026-04-01T00:00:00Z')
    const newerPre = new Date('2026-05-14T09:00:00Z')
    const live = new Date('2026-06-14T12:30:00Z')
    // Deliberately unsorted.
    const messages = [{ timestamp: live }, { timestamp: older }, {}, { timestamp: newerPre }]
    expect(findCatchUpCursorMessage(messages, sessionStart)?.timestamp).toBe(newerPre)
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
