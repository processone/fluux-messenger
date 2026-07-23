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
  sawCoverageTop: false,
  walkCarriedModifications: false,
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

  it('a walk that SAW the existing topId keeps the deeper bottom, refreshes topId', () => {
    // Codex r4 #3: only re-entering the covered region (the walk contained
    // the record's top entry) proves contiguity with the existing record.
    const coverage = new Map([['a@b', { bottomId: 'deep', topId: 'old-top' }]])
    const out = syncCoverageAfterArchiveMerge(
      base({ coverage, rsmFirst: 'shallow', fetchLatestTopId: 'new-top', sawCoverageTop: true })
    )
    expect(out.get('a@b')).toEqual({ bottomId: 'deep', topId: 'new-top' })
  })

  it('dedupe against arbitrary local data does NOT keep the old bottom (island overlap is no proof)', () => {
    // Codex r4 #3 scenario: coverage [100..200], fetchContext island
    // [280..320] resident, fetch-latest [301..400] dedupes against the
    // island. Keeping bottomId=100 would certify the hole [201..279].
    // Without sighting the record's topId, the record must be REPLACED by
    // the walked window.
    const coverage = new Map([['a@b', { bottomId: 'id-100', topId: 'id-200' }]])
    const out = syncCoverageAfterArchiveMerge(
      base({ coverage, rsmFirst: 'id-301', fetchLatestTopId: 'id-400', sawCoverageTop: false })
    )
    expect(out.get('a@b')).toEqual({ bottomId: 'id-301', topId: 'id-400' })
  })

  it('a walk that carried modifications never certifies coverage (their cache writes are fire-and-forget)', () => {
    // Codex r4 #2: corrections/retractions/reactions on walked pages are
    // applied via unawaited cache updates (and dropped entirely for
    // non-resident targets). Certifying the walk would let a later floor
    // jump skip them forever — so it must not form, extend, or refresh a
    // record.
    const empty = new Map<string, CoverageRecord>()
    expect(syncCoverageAfterArchiveMerge(
      base({ coverage: empty, rsmFirst: 'deep', fetchLatestTopId: 'top', walkCarriedModifications: true })
    )).toBe(empty)

    const existing = new Map([['a@b', { bottomId: 'deep', topId: 'top' }]])
    expect(syncCoverageAfterArchiveMerge(
      base({ coverage: existing, isFetchLatest: false, initialBefore: 'deep', rsmFirst: 'deeper', walkCarriedModifications: true })
    )).toBe(existing)
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

  describe('forward-catch-up bootstrap', () => {
    // Without this, a record can only be BORN by a `before:''` fetch-latest,
    // which selectCatchUpQuery only issues when the cache is EMPTY — an
    // entity's first-ever sync. Every entity cached before the record shipped
    // therefore never gets one, and Phase B permanently falls back to the
    // cache-bottom probe. A forward catch-up that reports complete proves
    // [resume cursor → live] is contiguous, which is exactly a coverage bottom.
    const fwd = (over: Partial<ArchiveMergeCoverageInput> = {}) =>
      base({ direction: 'forward', isFetchLatest: false, ...over })

    it('a completed forward catch-up seeds the record from its resume cursor', () => {
      const out = syncCoverageAfterArchiveMerge(fwd({ complete: true, initialAfter: 'local-edge' }))
      expect(out.get('a@b')).toEqual({ bottomId: 'local-edge' })
    })

    it('an INCOMPLETE forward catch-up seeds nothing (it never reached live)', () => {
      const coverage = new Map<string, CoverageRecord>()
      expect(
        syncCoverageAfterArchiveMerge(fwd({ coverage, complete: false, initialAfter: 'local-edge' }))
      ).toBe(coverage)
    })

    it('a completed forward catch-up never shallows an existing, deeper record', () => {
      const coverage = new Map([['a@b', { bottomId: 'much-deeper', topId: 'top' }]])
      expect(
        syncCoverageAfterArchiveMerge(fwd({ coverage, complete: true, initialAfter: 'local-edge' }))
      ).toBe(coverage)
    })

    it('a completed forward catch-up with no resume cursor seeds nothing', () => {
      // `start`-filtered or cursorless catch-up: no archive id to anchor on.
      const coverage = new Map<string, CoverageRecord>()
      expect(syncCoverageAfterArchiveMerge(fwd({ coverage, complete: true }))).toBe(coverage)
    })

    it('a completed forward catch-up that carried modifications never seeds', () => {
      // Same invariant the backward branch enforces (Codex r4 #2): the walk's
      // modification cache-writes are fire-and-forget, so nothing it touched is
      // durably confirmed enough to certify coverage.
      const coverage = new Map<string, CoverageRecord>()
      expect(
        syncCoverageAfterArchiveMerge(
          fwd({ coverage, complete: true, initialAfter: 'local-edge', walkCarriedModifications: true })
        )
      ).toBe(coverage)
    })

    it('a bounded windowed forward query never seeds (proves nothing about live)', () => {
      const coverage = new Map<string, CoverageRecord>()
      expect(
        syncCoverageAfterArchiveMerge(
          fwd({ coverage, complete: true, initialAfter: 'local-edge', preserveGapMarker: true })
        )
      ).toBe(coverage)
    })
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
