import { describe, it, expect } from 'vitest'
import {
  computeGapEnd,
  syncRoomGap,
  serializeRoomGaps,
  deserializeRoomGaps,
  type GapInterval,
} from './roomGap'

describe('computeGapEnd', () => {
  const start = new Date('2026-05-14T09:00:00Z').getTime()

  it('returns the oldest message timestamp strictly after the gap start', () => {
    const messages = [
      { timestamp: new Date('2026-05-14T08:00:00Z') }, // before start — ignored
      { timestamp: new Date('2026-06-10T12:00:00Z') }, // above gap
      { timestamp: new Date('2026-06-01T09:00:00Z') }, // oldest above gap → the end
    ]
    expect(computeGapEnd(messages, start)).toBe(new Date('2026-06-01T09:00:00Z').getTime())
  })

  it('returns undefined when nothing is newer than the gap start (gap extends to live)', () => {
    const messages = [
      { timestamp: new Date('2026-05-14T08:00:00Z') },
      { timestamp: new Date(start) }, // exactly at start — not strictly after
    ]
    expect(computeGapEnd(messages, start)).toBeUndefined()
  })

  it('ignores messages without timestamps', () => {
    expect(computeGapEnd([{}, { timestamp: new Date('2026-07-01T00:00:00Z') }, {}], start)).toBe(
      new Date('2026-07-01T00:00:00Z').getTime(),
    )
  })
})

describe('syncRoomGap', () => {
  it('records a gap interval when start is defined', () => {
    const result = syncRoomGap(new Map(), 'room@x', 1000, 5000)
    expect(result.get('room@x')).toEqual({ start: 1000, end: 5000 })
  })

  it('omits end when undefined (gap extends to live)', () => {
    const result = syncRoomGap(new Map(), 'room@x', 1000, undefined)
    expect(result.get('room@x')).toEqual({ start: 1000 })
  })

  it('clears the gap when start is undefined', () => {
    const gaps = new Map<string, GapInterval>([['room@x', { start: 1000, end: 5000 }]])
    const result = syncRoomGap(gaps, 'room@x', undefined, undefined)
    expect(result.has('room@x')).toBe(false)
  })

  it('returns the same map reference when nothing changes (no spurious writes)', () => {
    const gaps = new Map<string, GapInterval>([['room@x', { start: 1000, end: 5000 }]])
    expect(syncRoomGap(gaps, 'room@x', 1000, 5000)).toBe(gaps)
  })

  it('returns the same map reference when clearing an already-absent gap', () => {
    const gaps = new Map<string, GapInterval>()
    expect(syncRoomGap(gaps, 'room@x', undefined, undefined)).toBe(gaps)
  })
})

describe('serializeRoomGaps / deserializeRoomGaps', () => {
  it('round-trips a gap map', () => {
    const gaps = new Map<string, GapInterval>([
      ['a@x', { start: 1000, end: 5000 }],
      ['b@x', { start: 2000 }],
    ])
    const restored = deserializeRoomGaps(serializeRoomGaps(gaps))
    expect(restored.get('a@x')).toEqual({ start: 1000, end: 5000 })
    expect(restored.get('b@x')).toEqual({ start: 2000 })
  })

  it('returns an empty map for malformed JSON', () => {
    expect(deserializeRoomGaps('not json').size).toBe(0)
  })
})
