import { describe, it, expect } from 'vitest'
import {
  syncCoverageAfterArchiveMerge,
  serializeCoverage,
  deserializeCoverage,
  type CoverageRecord,
  type ArchiveMergeCoverageInput,
} from './mamCoverage'

const base = (over: Partial<ArchiveMergeCoverageInput> = {}): ArchiveMergeCoverageInput => ({
  coverage: new Map<string, CoverageRecord>(),
  id: 'a@b',
  direction: 'backward',
  isFetchLatest: true,
  preserveGapMarker: false,
  connectedToHeld: false,
  ...over,
})

describe('syncCoverageAfterArchiveMerge', () => {
  it('fetch-latest establishes the record from the walk extent', () => {
    const out = syncCoverageAfterArchiveMerge(base({ rsmFirst: 'deep', fetchLatestTopId: 'top' }))
    expect(out.get('a@b')).toEqual({ bottomId: 'deep', topId: 'top' })
  })

  it('signal-only give-up (zero messages, rsm.first set) still establishes the record', () => {
    // Codex r3 #4: the walked window IS proven contiguous coverage even with
    // zero displayable messages — this is the durable resume for the cap.
    const out = syncCoverageAfterArchiveMerge(base({ rsmFirst: 'page5-first', fetchLatestTopId: 'page1-last' }))
    expect(out.get('a@b')).toEqual({ bottomId: 'page5-first', topId: 'page1-last' })
  })

  it('disjoint fetch-latest REPLACES a stale record', () => {
    const coverage = new Map([['a@b', { bottomId: 'old-deep', topId: 'old-top' }]])
    const out = syncCoverageAfterArchiveMerge(base({ coverage, rsmFirst: 'new-deep', fetchLatestTopId: 'new-top' }))
    expect(out.get('a@b')).toEqual({ bottomId: 'new-deep', topId: 'new-top' })
  })

  it('connected fetch-latest keeps the deeper existing bottom, refreshes topId', () => {
    const coverage = new Map([['a@b', { bottomId: 'deep', topId: 'old-top' }]])
    const out = syncCoverageAfterArchiveMerge(
      base({ coverage, rsmFirst: 'shallow', fetchLatestTopId: 'new-top', connectedToHeld: true })
    )
    expect(out.get('a@b')).toEqual({ bottomId: 'deep', topId: 'new-top' })
  })

  it('plain backward page extends the bottom only when resumed exactly from it', () => {
    const coverage = new Map([['a@b', { bottomId: 'deep', topId: 'top' }]])
    const extended = syncCoverageAfterArchiveMerge(
      base({ coverage, isFetchLatest: false, initialBefore: 'deep', rsmFirst: 'deeper' })
    )
    expect(extended.get('a@b')).toEqual({ bottomId: 'deeper', topId: 'top' })
    const stray = syncCoverageAfterArchiveMerge(
      base({ coverage, isFetchLatest: false, initialBefore: 'elsewhere', rsmFirst: 'x' })
    )
    expect(stray).toBe(coverage) // copy-on-write no-op
  })

  it('never touches the record for preserveGapMarker (windowed) or forward merges', () => {
    const coverage = new Map([['a@b', { bottomId: 'deep' }]])
    expect(syncCoverageAfterArchiveMerge(base({ coverage, preserveGapMarker: true, rsmFirst: 'x' }))).toBe(coverage)
    expect(
      syncCoverageAfterArchiveMerge(base({ coverage, direction: 'forward', isFetchLatest: false, rsmFirst: 'x' }))
    ).toBe(coverage)
  })

  it('empty fetch-latest with no rsm.first (empty archive) is a no-op', () => {
    const coverage = new Map<string, CoverageRecord>()
    expect(syncCoverageAfterArchiveMerge(base({ coverage }))).toBe(coverage)
  })

  it('returns the same reference when the computed record is unchanged', () => {
    const coverage = new Map([['a@b', { bottomId: 'deep', topId: 'top' }]])
    expect(syncCoverageAfterArchiveMerge(base({ coverage, rsmFirst: 'deep', fetchLatestTopId: 'top' }))).toBe(coverage)
  })
})

describe('coverage (de)serialization', () => {
  it('round-trips', () => {
    const m = new Map([['a@b', { bottomId: 'x', topId: 'y' }]])
    expect(deserializeCoverage(serializeCoverage(m))).toEqual(m)
  })

  it('returns empty map on garbage', () => {
    expect(deserializeCoverage('nope').size).toBe(0)
  })

  it('drops malformed entries missing bottomId', () => {
    const json = JSON.stringify([['a@b', { topId: 'only-top' }], ['c@d', { bottomId: 'ok' }]])
    const out = deserializeCoverage(json)
    expect(out.has('a@b')).toBe(false)
    expect(out.get('c@d')).toEqual({ bottomId: 'ok' })
  })
})
