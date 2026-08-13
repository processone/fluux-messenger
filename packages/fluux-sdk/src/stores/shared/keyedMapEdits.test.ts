import { describe, it, expect } from 'vitest'
import {
  clearMarker,
  lastMessageTimestamp,
  clearCoverageEntry,
  clearGapAnchor,
} from './keyedMapEdits'
import type { CoverageRecord } from '../../core/types'
import type { GapInterval } from './mamGap'

/**
 * The `null` return is the contract these share: it is what lets a Zustand
 * `set` hand back the same state object and skip the re-render, so a no-op that
 * returned a fresh map would be a render-loop defect, not a style question.
 */
describe('clearMarker', () => {
  it('returns null when the entity has no marker, leaving the map identical', () => {
    const markers = new Map([['a@x', 'm1']])
    expect(clearMarker(markers, 'b@x')).toBeNull()
  })

  it('removes only the named entity, in a fresh map', () => {
    const markers = new Map([['a@x', 'm1'], ['b@x', 'm2']])
    const next = clearMarker(markers, 'a@x')!
    expect(next).not.toBe(markers)
    expect([...next.keys()]).toEqual(['b@x'])
    expect(markers.has('a@x')).toBe(true)
  })
})

describe('lastMessageTimestamp', () => {
  const at = (ms: number) => ({ lastMessage: { timestamp: new Date(ms) } })

  it('prefers metadata, which is the map kept current', () => {
    expect(lastMessageTimestamp(new Map([['a', at(200)]]), new Map([['a', at(100)]]), 'a')).toBe(200)
  })

  it('falls back to the compat map, which persisted state can populate alone', () => {
    expect(lastMessageTimestamp(new Map(), new Map([['a', at(100)]]), 'a')).toBe(100)
  })

  it('is undefined for an unknown entity, and for one with no last message', () => {
    expect(lastMessageTimestamp(new Map(), new Map(), 'a')).toBeUndefined()
    expect(lastMessageTimestamp(new Map([['a', {}]]), new Map(), 'a')).toBeUndefined()
  })
})

describe('clearCoverageEntry', () => {
  const coverage = (): Map<string, CoverageRecord> => new Map([['a', { bottomId: 'b1' }]])

  it('returns null when there is no record', () => {
    expect(clearCoverageEntry(new Map(), 'a', 'b1')).toBeNull()
  })

  it('deletes unconditionally when no guard is given', () => {
    expect(clearCoverageEntry(coverage(), 'a')!.has('a')).toBe(false)
  })

  it('deletes when the guard matches the record it was observed on', () => {
    expect(clearCoverageEntry(coverage(), 'a', 'b1')!.has('a')).toBe(false)
  })

  it('leaves a record another path has since replaced', () => {
    expect(clearCoverageEntry(coverage(), 'a', 'stale')).toBeNull()
  })
})

describe('clearGapAnchor', () => {
  const gaps = (): Map<string, GapInterval> =>
    new Map([['a', { start: 10, startId: 'g1', endId: 'g9' } as GapInterval]])

  it('returns null when there is no gap for the entity', () => {
    expect(clearGapAnchor(new Map(), 'a', 'g1')).toBeNull()
  })

  it('returns null when the anchor has moved since it was observed', () => {
    expect(clearGapAnchor(gaps(), 'a', 'stale')).toBeNull()
  })

  it('drops the anchor and KEEPS the gap — the hole is still real', () => {
    const next = clearGapAnchor(gaps(), 'a', 'g1')!
    const gap = next.get('a')!
    expect(gap).toBeDefined()
    expect('startId' in gap).toBe(false)
    expect(gap.start).toBe(10)
    expect(gap.endId).toBe('g9')
  })
})
