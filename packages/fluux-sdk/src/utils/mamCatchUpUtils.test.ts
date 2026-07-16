import { describe, it, expect } from 'vitest'
import {
  findNewestMessage,
  findCatchUpCursorMessage,
  selectCatchUpQuery,
  selectRoomsNeedingResumeSeed,
  buildCatchUpStartTime,
  isConnectionError,
  oldestMessageWithStanzaId,
  MAM_POINTER_RECOUNT_CACHE_LIMIT,
  MAM_POINTER_STITCH_MAX_PAGES,
  MAM_POINTER_SEED_PROBE_LIMIT,
  MAM_ROOM_FORWARD_MAX_PAGES_MANUAL,
  MAM_CATCHUP_FORWARD_MAX,
  MAM_CATCHUP_BACKWARD_MAX,
  MAM_CATCHUP_FORWARD_BAIL_PAGES,
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
// selectCatchUpQuery (shared cursor policy for chat + room)
// ============================================================================

describe('selectCatchUpQuery (latest-first, id-anchored coverage cursor)', () => {
  it('returns before:"" when the local cache is empty', () => {
    expect(selectCatchUpQuery([])).toEqual({ before: '' })
  })

  it('anchors by ARCHIVE ID when the newest pre-session message has a stanza-id', () => {
    const messages = [
      { timestamp: new Date('2026-05-14T09:00:00.000Z'), stanzaId: 'cov-42' },
      { timestamp: new Date('2026-06-14T12:00:05.000Z'), stanzaId: 'live-1' }, // this session
    ]
    expect(selectCatchUpQuery(messages, { sessionStartTime: new Date('2026-06-14T12:00:00Z').getTime() }))
      .toEqual({ after: 'cov-42' })
  })

  it('falls back to a timestamp anchor when the coverage message has no stanza-id', () => {
    const messages = [{ timestamp: new Date('2026-05-14T09:00:00.000Z') }]
    expect(selectCatchUpQuery(messages, { sessionStartTime: new Date('2026-06-14T12:00:00Z').getTime() }))
      .toEqual({ start: '2026-05-14T09:00:00.001Z' })
  })

  it('prefers the recorded gap boundary (id-exact) over newer cached messages', () => {
    const messages = [{ timestamp: new Date('2026-06-01T12:00:00Z'), stanzaId: 'newer' }]
    expect(selectCatchUpQuery(messages, {
      forwardGapTimestamp: new Date('2026-05-14T09:00:00.000Z').getTime(),
      forwardGapStartId: 'gap-edge-7',
    })).toEqual({ after: 'gap-edge-7' })
  })

  it('resumes a recorded gap by timestamp when it carries no id (legacy persisted gap)', () => {
    const messages = [{ timestamp: new Date('2026-06-01T12:00:00Z'), stanzaId: 'newer' }]
    expect(selectCatchUpQuery(messages, { forwardGapTimestamp: new Date('2026-05-14T09:00:00.000Z').getTime() }))
      .toEqual({ start: '2026-05-14T09:00:00.001Z' })
  })

  it('returns before:"" when every cached message is from this session', () => {
    const messages = [{ timestamp: new Date('2026-06-14T12:00:05.000Z'), stanzaId: 's1' }]
    expect(selectCatchUpQuery(messages, { sessionStartTime: new Date('2026-06-14T12:00:00Z').getTime() }))
      .toEqual({ before: '' })
  })

  it('with no sessionStartTime, anchors on the GLOBAL newest message, id-exact (live fetchHistory path)', () => {
    // Without a sessionStartTime, selectCatchUpQuery falls back to
    // findNewestMessage instead of findCatchUpCursorMessage — this is the
    // path fetchHistory (the live, non-catch-up caller) uses.
    const t1 = new Date('2026-06-01T00:00:00Z')
    const t2 = new Date('2026-06-14T12:00:00Z')
    expect(selectCatchUpQuery([{ timestamp: t1, stanzaId: 'a' }, { timestamp: t2, stanzaId: 'b' }]))
      .toEqual({ after: 'b' })
  })
})

// ============================================================================
// Manual repair pagination cap
// ============================================================================

describe('MAM_ROOM_FORWARD_MAX_PAGES_MANUAL', () => {
  it('is larger than the background forward cap so user-initiated repair paginates further', () => {
    expect(MAM_ROOM_FORWARD_MAX_PAGES_MANUAL).toBeGreaterThan(MAM_ROOM_FORWARD_MAX_PAGES)
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
// selectRoomsNeedingResumeSeed
// ============================================================================

describe('selectRoomsNeedingResumeSeed', () => {
  const notCaughtUp = () => false

  const room = (
    over: Partial<{
      jid: string
      joined: boolean
      supportsMAM: boolean
      isQuickChat: boolean
      lastMessage: unknown
    }> = {},
  ) => ({
    jid: 'room@conf.example.com',
    joined: true,
    supportsMAM: true,
    isQuickChat: false,
    lastMessage: undefined as unknown,
    ...over,
  })

  it('includes a joined MAM room that is not caught up to live', () => {
    const r = room({ jid: 'unseeded@conf.example.com' })
    expect(selectRoomsNeedingResumeSeed([r], notCaughtUp, null)).toEqual([r])
  })

  it('includes a previewed room with an open gap (has lastMessage but not caught up to live)', () => {
    // The widened scope: a previously-seeded room whose forward catch-up never
    // completed (isCaughtUpToLive false) is refreshed on resume, not left stale
    // until the user opens it. #784 excluded it because it had a preview.
    const r = room({ jid: 'gap@conf.example.com', lastMessage: { id: 'm1' } })
    expect(selectRoomsNeedingResumeSeed([r], notCaughtUp, null)).toEqual([r])
  })

  it('excludes a room already caught up to live', () => {
    const r = room({ jid: 'live@conf.example.com' })
    const isCaughtUpToLive = (jid: string) => jid === 'live@conf.example.com'
    expect(selectRoomsNeedingResumeSeed([r], isCaughtUpToLive, null)).toEqual([])
  })

  it('excludes QuickChat rooms', () => {
    const r = room({ jid: 'quick@conf.example.com', isQuickChat: true })
    expect(selectRoomsNeedingResumeSeed([r], notCaughtUp, null)).toEqual([])
  })

  it('excludes rooms that do not support MAM', () => {
    const r = room({ jid: 'nomam@conf.example.com', supportsMAM: false })
    expect(selectRoomsNeedingResumeSeed([r], notCaughtUp, null)).toEqual([])
  })

  it('excludes rooms that are not joined', () => {
    const r = room({ jid: 'left@conf.example.com', joined: false })
    expect(selectRoomsNeedingResumeSeed([r], notCaughtUp, null)).toEqual([])
  })

  it('excludes the active room (handled by roomSideEffects)', () => {
    const r = room({ jid: 'active@conf.example.com' })
    expect(
      selectRoomsNeedingResumeSeed([r], notCaughtUp, 'active@conf.example.com'),
    ).toEqual([])
  })

  it('returns only the eligible rooms from a mixed set', () => {
    const eligible = room({ jid: 'a@conf.example.com' })
    const live = room({ jid: 'b@conf.example.com' })
    const quick = room({ jid: 'c@conf.example.com', isQuickChat: true })
    const active = room({ jid: 'd@conf.example.com' })
    const isCaughtUpToLive = (jid: string) => jid === 'b@conf.example.com'
    const result = selectRoomsNeedingResumeSeed(
      [eligible, live, quick, active],
      isCaughtUpToLive,
      'd@conf.example.com',
    )
    expect(result).toEqual([eligible])
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
    expect(MAM_CATCHUP_FORWARD_BAIL_PAGES).toBe(3)
    expect(MAM_POINTER_STITCH_MAX_PAGES).toBe(10)
    expect(MAM_POINTER_SEED_PROBE_LIMIT).toBe(25)
  })

  it('sizes the exact-recount window to everything one catch-up pass can download', () => {
    expect(MAM_POINTER_RECOUNT_CACHE_LIMIT).toBe(
      MAM_CATCHUP_BACKWARD_MAX + MAM_POINTER_STITCH_MAX_PAGES * MAM_CATCHUP_FORWARD_MAX + MAM_CATCHUP_BACKWARD_MAX
    )
  })
})

// ============================================================================
// oldestMessageWithStanzaId
// ============================================================================

describe('oldestMessageWithStanzaId', () => {
  it('returns the oldest-timestamped message that carries a stanzaId', () => {
    const messages = [
      { timestamp: new Date('2026-06-14T10:00:00Z'), stanzaId: 'newer' },
      { timestamp: new Date('2026-06-14T08:00:00Z'), stanzaId: 'oldest-with-id' },
      { timestamp: new Date('2026-06-14T09:00:00Z'), stanzaId: 'mid' },
    ]
    expect(oldestMessageWithStanzaId(messages)?.stanzaId).toBe('oldest-with-id')
  })

  it('skips older messages WITHOUT a stanzaId (unlike mamGap.oldestMessageStanzaId)', () => {
    const messages = [
      { timestamp: new Date('2026-06-14T08:00:00Z') }, // own-sent, never archived
      { timestamp: new Date('2026-06-14T09:00:00Z'), stanzaId: 'first-archived' },
    ]
    expect(oldestMessageWithStanzaId(messages)?.stanzaId).toBe('first-archived')
  })

  it('ignores messages without a timestamp and returns undefined when nothing qualifies', () => {
    expect(oldestMessageWithStanzaId([])).toBeUndefined()
    expect(oldestMessageWithStanzaId([{ stanzaId: 'no-ts' }])).toBeUndefined()
    expect(oldestMessageWithStanzaId([{ timestamp: new Date(), stanzaId: undefined }])).toBeUndefined()
  })
})
