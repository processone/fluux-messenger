/**
 * Property tests for the contiguous-with-live coverage record.
 *
 * The `CoverageTransition` this module returns is not a description — it is the
 * persistence layer's durability input, and only `replaced` force-flushes.
 * The module states the stakes itself: every safe transition errs SHALLOW,
 * costing a re-walk, and only `replaced` can leave disk asserting coverage that
 * does not exist. So the property that matters is LABEL FIDELITY: a run that
 * overwrites a recorded bottom without proving contiguity must say so, because
 * a mislabel means disk keeps a record this very walk disproved and the next
 * session seeds its backward walk from it — skipping real history.
 *
 * Archive ids are non-sequential (see `mamGap`), so nothing downstream can
 * recompute this by comparing two ids. The label is the only signal.
 */
import { describe, expect, it } from 'vitest'
import 'fake-indexeddb/auto'
import fc from 'fast-check'
import {
  deserializeCoverage,
  isCaughtUpForCounting,
  serializeCoverage,
  syncCoverageAfterArchiveMerge,
  type ArchiveMergeCoverageInput,
  type CoverageRecord,
} from './mamCoverage'

const IDS = ['a@b', 'c@d'] as const
/** Archive ids drawn from a tiny pool so cursors coincide with recorded edges. */
const ARCHIVE_IDS = ['x1', 'x2', 'x3'] as const
const maybeArchiveId = fc.option(fc.constantFrom(...ARCHIVE_IDS), { nil: undefined })

const recordArb: fc.Arbitrary<CoverageRecord> = fc.record({
  bottomId: fc.constantFrom(...ARCHIVE_IDS),
  topId: maybeArchiveId,
})

const coverageArb = fc
  .array(fc.tuple(fc.constantFrom(...IDS), recordArb), { maxLength: 2 })
  .map((entries) => new Map<string, CoverageRecord>(entries))

const inputArb: fc.Arbitrary<ArchiveMergeCoverageInput> = fc.record({
  coverage: coverageArb,
  id: fc.constantFrom(...IDS),
  direction: fc.constantFrom<'backward' | 'forward'>('backward', 'forward'),
  isFetchLatest: fc.boolean(),
  complete: fc.option(fc.boolean(), { nil: undefined }),
  initialAfter: maybeArchiveId,
  preserveGapMarker: fc.boolean(),
  rsmFirst: maybeArchiveId,
  fetchLatestTopId: maybeArchiveId,
  initialBefore: maybeArchiveId,
  sawCoverageTop: fc.boolean(),
  walkCarriedModifications: fc.boolean(),
})

describe('coverage transition labels are faithful', () => {
  it('signals every overwrite of a recorded bottom', () => {
    // The safety property. A bottom that moves without the walk having resumed
    // id-exactly from it is an unproven claim, and the persistence layer only
    // learns that from the label.
    fc.assert(
      fc.property(inputArb, (input) => {
        const before = input.coverage.get(input.id)
        const { coverage, transition } = syncCoverageAfterArchiveMerge(input)
        const after = coverage.get(input.id)
        if (!before || !after) return
        if (after.bottomId === before.bottomId) return

        expect(['deepened', 'replaced']).toContain(transition)
      }),
      { numRuns: 5000 },
    )
  })

  it('only calls it deepened when the walk resumed id-exactly from the recorded bottom', () => {
    // `deepened` is the label that lets the write ride the throttle. It is only
    // safe because losing it leaves the shallower bottom, which is still true —
    // and that holds only when the new bottom extends the SAME contiguous run.
    fc.assert(
      fc.property(inputArb, (input) => {
        const before = input.coverage.get(input.id)
        const { transition } = syncCoverageAfterArchiveMerge(input)
        if (transition !== 'deepened') return

        expect(before).toBeDefined()
        expect(input.initialBefore).toBe(before!.bottomId)
        expect(input.direction).toBe('backward')
        expect(input.isFetchLatest).toBe(false)
      }),
      { numRuns: 5000 },
    )
  })

  it('reserves replaced for an unproven overwrite of an existing record', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const before = input.coverage.get(input.id)
        const { transition } = syncCoverageAfterArchiveMerge(input)
        if (transition !== 'replaced') return

        expect(before).toBeDefined()
        expect(input.isFetchLatest).toBe(true)
        // Having SEEN the record's top entry is the proof that would have kept
        // the deeper bottom; `replaced` means that proof was absent.
        expect(input.sawCoverageTop).toBe(false)
      }),
      { numRuns: 5000 },
    )
  })

  it('creates only where there was nothing, and refreshes only the top', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const before = input.coverage.get(input.id)
        const { coverage, transition } = syncCoverageAfterArchiveMerge(input)
        const after = coverage.get(input.id)

        if (transition === 'created') {
          expect(before).toBeUndefined()
          expect(after).toBeDefined()
        }
        if (transition === 'topRefreshed') {
          expect(before).toBeDefined()
          expect(after!.bottomId).toBe(before!.bottomId)
          expect(after!.topId).not.toBe(before!.topId)
        }
      }),
      { numRuns: 5000 },
    )
  })
})

describe('coverage map discipline', () => {
  it('is copy-on-write: the same reference exactly when the label says none', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const { coverage, transition } = syncCoverageAfterArchiveMerge(input)
        expect(coverage === input.coverage).toBe(transition === 'none')
      }),
      { numRuns: 5000 },
    )
  })

  it('never drops a record, and never touches another entity', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const { coverage } = syncCoverageAfterArchiveMerge(input)
        for (const [key, value] of input.coverage) {
          expect(coverage.has(key)).toBe(true)
          if (key !== input.id) expect(coverage.get(key)).toBe(value)
        }
      }),
      { numRuns: 5000 },
    )
  })

  it('certifies nothing when the walk proves nothing', () => {
    // A bounded windowed query proves nothing about live contiguity, and a walk
    // whose modifications were written fire-and-forget is not durably confirmed.
    fc.assert(
      fc.property(inputArb, (input) => {
        if (!input.preserveGapMarker && !input.walkCarriedModifications) return
        const { coverage, transition } = syncCoverageAfterArchiveMerge(input)
        expect(transition).toBe('none')
        expect(coverage).toBe(input.coverage)
      }),
      { numRuns: 5000 },
    )
  })

  it('round-trips through serialisation, and never throws on hostile input', () => {
    fc.assert(
      fc.property(coverageArb, (map) => {
        expect(deserializeCoverage(serializeCoverage(map))).toEqual(map)
      }),
      { numRuns: 2000 },
    )
    fc.assert(
      fc.property(fc.string(), (raw) => {
        expect(() => deserializeCoverage(raw)).not.toThrow()
      }),
      { numRuns: 2000 },
    )
  })
})

describe('the counting gate', () => {
  it('never consults hasQueried', () => {
    // A restored entity carries persisted coverage while `hasQueried` is false,
    // because that flag is session-scoped. Counting on it would under-count at
    // cold start and overwrite a correct persisted value — the unsafe direction.
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), (isLoading, isCaughtUpToLive) => {
        expect(isCaughtUpForCounting({ hasQueried: true, isLoading, isCaughtUpToLive })).toBe(
          isCaughtUpForCounting({ hasQueried: false, isLoading, isCaughtUpToLive }),
        )
      }),
    )
  })

  it('requires both settled loading and proven live contiguity', () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), fc.boolean(), (hasQueried, isLoading, isCaughtUpToLive) => {
        expect(isCaughtUpForCounting({ hasQueried, isLoading, isCaughtUpToLive })).toBe(
          !isLoading && isCaughtUpToLive,
        )
      }),
    )
  })
})
