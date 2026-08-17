import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { localStorageMock } from '../../core/sideEffects.testHelpers'

Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true })

import { scheduleDurableMaps, cancelDurableMaps, forgetAllDurableMapBaselines, noteCoverageTransition } from './durableMapPersist'
import type { DurableMaps } from './durableMapPersist'
import { _resetForTesting, flush } from './throttledStorage'
import type { GapInterval } from './mamGap'
import type { CoverageRecord } from './mamCoverage'

/**
 * Direct unit tests for the structural-transition predicate.
 *
 * The store suites (`roomStore.throttledPersist`, `chatStore.persist`) prove the
 * two write funnels are wired to this module and that the durability property
 * holds end to end. They cannot cheaply reach every row of design §4.2's
 * decision table, nor the two invariants this module documents but nothing else
 * exercises: that the baseline advances on THROTTLED writes too (the A → B → A
 * case), and that `cancelDurableMaps` drops it.
 *
 * They also cannot see the shape hazard: every field of `DurableMaps` is
 * optional, so `{ gap: … }` for `{ gaps: … }` type-checks and silently disables
 * detection for that map. The "omitting a map" test below is what states the
 * consequence out loud.
 *
 * Sequencing note, true of every test here: the FIRST write for a key has no
 * baseline, so any map entry present reads as an addition and force-flushes —
 * which CLOSES the window. A test of "this transition stays throttled" therefore
 * needs THREE writes: one to establish the baseline, one to re-open the window,
 * and the one under test. Same trap the store suites hit (§5.5).
 */
const KEY = 'durable-map-persist-test'

function writeCount(): number {
  return localStorageMock.setItem.mock.calls.length
}

function onDisk(): string {
  return localStorage.getItem(KEY) ?? ''
}

/** `scheduleDurableMaps` with a marker payload, so disk state identifies the write. */
function write(maps: DurableMaps, marker: string): void {
  scheduleDurableMaps(KEY, maps, () => marker)
}

function gaps(entries: Record<string, GapInterval>): ReadonlyMap<string, GapInterval> {
  return new Map(Object.entries(entries))
}

function coverage(entries: Record<string, CoverageRecord>): ReadonlyMap<string, CoverageRecord> {
  return new Map(Object.entries(entries))
}

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  _resetForTesting()
  forgetAllDurableMapBaselines()
  localStorageMock.setItem.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('durableMapPersist — §4.2 decision table', () => {
  it('gap key ADDED forces the coalesced write out of the window', () => {
    write({ gaps: gaps({ a: { start: 1000 } }) }, 'baseline') // force-flush, window CLOSED
    write({ gaps: gaps({ a: { start: 1000, end: 900 } }) }, 'opener') // shrink → leading edge, window OPEN
    expect(writeCount()).toBe(2)

    write({ gaps: gaps({ a: { start: 1000, end: 900 }, b: { start: 5000 } }) }, 'formation')

    expect(writeCount()).toBe(3)
    expect(onDisk()).toBe('formation')
  })

  it('gap shrink / close / removal stays throttled', () => {
    write({ gaps: gaps({ a: { start: 1000 }, b: { start: 2000 } }) }, 'baseline')
    write({ gaps: gaps({ a: { start: 1000, end: 900 }, b: { start: 2000 } }) }, 'opener')
    expect(writeCount()).toBe(2)

    write({ gaps: gaps({ a: { start: 1000, end: 950 }, b: { start: 2000 } }) }, 'shrink')
    write({ gaps: gaps({ a: { start: 1000, end: 950 } }) }, 'removal') // b closed entirely

    expect(writeCount()).toBe(2)
    expect(onDisk()).toBe('opener')
    flush()
    expect(onDisk()).toBe('removal')
  })

  /**
   * #1138. A creation asserts nothing that a hard kill could falsify: losing it
   * leaves NO record on disk, and the next session re-seeds from the local
   * downloaded edge, which is shallower. #1133 force-flushed it only because
   * this layer could not tell it from a replacement — which is now signalled.
   *
   * This is the row that carried the whole cold-start cost: one forced
   * whole-blob serialization per conversation with no record, ~400 on the
   * reference profile.
   */
  it('coverage key ADDED stays throttled', () => {
    write({ coverage: coverage({ a: { bottomId: 'x', topId: 't1' } }) }, 'baseline')
    write({ coverage: coverage({ a: { bottomId: 'x', topId: 't2' } }) }, 'opener') // topId only
    expect(writeCount()).toBe(2)

    write({ coverage: coverage({ a: { bottomId: 'x', topId: 't2' }, b: { bottomId: 'y' } }) }, 'added')

    expect(writeCount()).toBe(2)
    expect(onDisk()).toBe('opener')
    flush()
    expect(onDisk()).toBe('added')
  })

  /**
   * #1138. Phase B's read-pointer stitch advances `bottomId` on up to 10 pages
   * per entity per session, each one an id-exact extension of the SAME
   * contiguous run. Losing one leaves the shallower bottom, which is still
   * true, and costs a re-walk of covered ground.
   */
  it('coverage bottomId DEEPENED without a signal stays throttled', () => {
    write({ coverage: coverage({ a: { bottomId: 'deep-old', topId: 't1' } }) }, 'baseline')
    write({ coverage: coverage({ a: { bottomId: 'deep-old', topId: 't2' } }) }, 'opener')
    expect(writeCount()).toBe(2)

    write({ coverage: coverage({ a: { bottomId: 'deeper', topId: 't2' } }) }, 'deepened')

    expect(writeCount()).toBe(2)
    expect(onDisk()).toBe('opener')
    flush()
    expect(onDisk()).toBe('deepened')
  })

  /**
   * The unsafe one. Same shape of write as `deepened` above — a `bottomId`
   * change on an existing id — and the ONLY thing that distinguishes them is
   * the signal, which is why both rows have to be here.
   */
  it('coverage REPLACEMENT, signalled, forces the coalesced write out of the window', () => {
    write({ coverage: coverage({ a: { bottomId: 'deep-old', topId: 't1' } }) }, 'baseline')
    write({ coverage: coverage({ a: { bottomId: 'deep-old', topId: 't2' } }) }, 'opener')
    expect(writeCount()).toBe(2)

    noteCoverageTransition(KEY, 'a', 'replaced')
    write({ coverage: coverage({ a: { bottomId: 'new-shallow' } }) }, 'replacement')

    expect(writeCount()).toBe(3)
    expect(onDisk()).toBe('replacement')
  })

  it('coverage key REMOVED forces the coalesced write out of the window', () => {
    write({ coverage: coverage({ a: { bottomId: 'x', topId: 't1' }, b: { bottomId: 'y' } }) }, 'baseline')
    write({ coverage: coverage({ a: { bottomId: 'x', topId: 't2' }, b: { bottomId: 'y' } }) }, 'opener')
    expect(writeCount()).toBe(2)

    write({ coverage: coverage({ a: { bottomId: 'x', topId: 't2' } }) }, 'removal')

    expect(writeCount()).toBe(3)
    expect(onDisk()).toBe('removal')
  })

  it('coverage topId-only change (re-entry marker) stays throttled', () => {
    write({ coverage: coverage({ a: { bottomId: 'x', topId: 't1' } }) }, 'baseline')
    write({ coverage: coverage({ a: { bottomId: 'x', topId: 't2' } }) }, 'opener')
    expect(writeCount()).toBe(2)

    write({ coverage: coverage({ a: { bottomId: 'x', topId: 't3' } }) }, 'refresh')

    expect(writeCount()).toBe(2)
    expect(onDisk()).toBe('opener')
    flush()
    expect(onDisk()).toBe('refresh')
  })
})

describe('durableMapPersist — baseline lifecycle', () => {
  /**
   * The A → B → A case the module doc calls out. The baseline must advance on
   * every write, INCLUDING the throttled ones — otherwise the return to A
   * compares equal to the pre-A baseline and its force-flush is skipped.
   */
  it('advances the baseline on throttled writes, so a there-and-back gap still flushes', () => {
    write({ gaps: gaps({ a: { start: 1000 } }) }, 'A') // formation → force-flush, window CLOSED
    expect(writeCount()).toBe(1)

    write({ gaps: gaps({}) }, 'B') // removal → throttled, leading edge, window OPEN
    expect(writeCount()).toBe(2)

    // Back to A. Against the just-advanced (empty) baseline this is a FORMATION
    // again. Against a baseline frozen at the first write it would look like a
    // no-op and sit in the pending thunk until the timer.
    write({ gaps: gaps({ a: { start: 1000 } }) }, 'A-again')

    expect(writeCount()).toBe(3)
    expect(onDisk()).toBe('A-again')
  })

  /**
   * `DurableMaps`' fields are optional by design — roomStore's two funnels each
   * carry ONE map — but that also means a typo (`{ gap: … }`) type-checks and
   * silently disables detection. This pins the contract in both directions.
   */
  it('omitting a map leaves its baseline alone and detects nothing for it', () => {
    write({ gaps: gaps({ a: { start: 1000 } }) }, 'baseline') // force-flush, window CLOSED
    write({ gaps: gaps({ a: { start: 1000, end: 900 } }) }, 'opener') // window OPEN
    expect(writeCount()).toBe(2)

    // A write carrying NEITHER map — what a `{ gap: … }` typo produces. The gap
    // formation it happens to describe is invisible here, so it coalesces.
    write({}, 'silent')
    expect(writeCount()).toBe(2)

    // …and the gap baseline was left untouched by that write, so the SAME
    // formation still force-flushes when it is actually declared.
    write({ gaps: gaps({ a: { start: 1000, end: 900 }, b: { start: 5000 } }) }, 'declared')
    expect(writeCount()).toBe(3)
    expect(onDisk()).toBe('declared')
  })

  /**
   * A cancelled write means the disk no longer matches the baseline, so keeping
   * it would let a later formation compare equal to a state that was never
   * persisted and skip its flush.
   *
   * The observation is indirect on purpose: the write right after the cancel is
   * a leading edge either way, so it always lands. What differs is whether it
   * force-flushed and thereby CLOSED the window — which is what the following
   * throttled write reveals.
   */
  it('cancelDurableMaps drops the baseline', () => {
    write({ gaps: gaps({ a: { start: 1000 } }) }, 'first') // force-flush, window CLOSED
    cancelDurableMaps(KEY)

    // Baseline gone → 'a' reads as a formation again → force-flush → window CLOSED.
    // With the baseline retained this would be a plain leading edge that leaves
    // the window OPEN.
    write({ gaps: gaps({ a: { start: 1000 } }) }, 'second')
    expect(onDisk()).toBe('second')

    // Not structural against the baseline this write compares to, so it is
    // throttled: it lands only because the window above was closed.
    write({ gaps: gaps({ a: { start: 1000, end: 900 } }) }, 'third')
    expect(onDisk()).toBe('third')
  })

  it('forgetAllDurableMapBaselines makes the next write structural again', () => {
    write({ coverage: coverage({ a: { bottomId: 'x', topId: 't1' } }) }, 'baseline')
    write({ coverage: coverage({ a: { bottomId: 'x', topId: 't2' } }) }, 'opener') // window OPEN
    expect(writeCount()).toBe(2)

    forgetAllDurableMapBaselines()

    // Unknown baseline → a removal is undetectable, so any record present is
    // treated as structural → force-flush, landing what would otherwise be a
    // coalesced topId refresh.
    write({ coverage: coverage({ a: { bottomId: 'x', topId: 't3' } }) }, 'after-forget')
    expect(writeCount()).toBe(3)
    expect(onDisk()).toBe('after-forget')
  })
})

/**
 * The replacement signal (#1138).
 *
 * With creation and deepening throttled, this signal is the ONLY thing standing
 * between a disproven coverage record and a hard kill, so its lifecycle needs
 * pinning as tightly as the transition rows themselves. Every test here opens
 * the window first, on this key, so the ordinary path would not have persisted.
 */
describe('durableMapPersist — coverage invalidation signal', () => {
  function openWindow(): void {
    write({ coverage: coverage({ a: { bottomId: 'x', topId: 't1' } }) }, 'baseline') // force-flush, CLOSED
    write({ coverage: coverage({ a: { bottomId: 'x', topId: 't2' } }) }, 'opener') // throttled, OPEN
    expect(writeCount()).toBe(2)
  }

  /** One signal must not make every LATER write durable too — that would put
   *  back most of the cost this change removes. */
  it('is consumed by exactly one write', () => {
    openWindow()

    noteCoverageTransition(KEY, 'a', 'replaced')
    write({ coverage: coverage({ a: { bottomId: 'replaced' } }) }, 'replacement')
    expect(writeCount()).toBe(3) // flushed, window CLOSED

    write({ coverage: coverage({ a: { bottomId: 'replaced', topId: 't9' } }) }, 'after-1') // leading edge
    expect(writeCount()).toBe(4)
    write({ coverage: coverage({ a: { bottomId: 'replaced', topId: 't10' } }) }, 'after-2')
    expect(writeCount()).toBe(4) // coalesced — the signal did not carry over
    expect(onDisk()).toBe('after-1')
  })

  /**
   * The signal means "this key's next write must be durable" and does not
   * depend on the write declaring the coverage map. Neither store can currently
   * produce that sequence — chat carries both maps in one blob, rooms give
   * coverage its own key — but a signal silently swallowed by an undeclared map
   * is the failure this module must not have.
   */
  it('forces the flush even when the write omits the coverage map', () => {
    openWindow()

    noteCoverageTransition(KEY, 'a', 'replaced')
    write({}, 'undeclared')

    expect(writeCount()).toBe(3)
    expect(onDisk()).toBe('undeclared')
  })

  /**
   * Both clear-path tests below write an EMPTY coverage map, and that is the
   * whole trick.
   *
   * Dropping the baseline makes the next non-empty write structural on its own
   * (`hasCoverageRemoval` cannot rule out a removal without a baseline), which
   * would mask a leaked signal completely — §5.5's "a test cannot cover a guard
   * a preceding guard renders unreachable". With an empty map the unknown
   * baseline is quiet, so the only thing that can force a flush is a signal
   * that outlived the clear.
   */
  it('cancelDurableMaps drops a pending signal with the write it was waiting for', () => {
    openWindow()

    noteCoverageTransition(KEY, 'a', 'replaced')
    cancelDurableMaps(KEY) // closes the window, so the next write is a leading edge

    write({ coverage: coverage({}) }, 'after-cancel')
    expect(writeCount()).toBe(3)

    // Discriminating step: a leaked signal would have force-flushed
    // 'after-cancel' and CLOSED the window, making this a fresh leading edge.
    write({ coverage: coverage({}) }, 'coalesced')
    expect(writeCount()).toBe(3)
    expect(onDisk()).toBe('after-cancel')
  })

  it('forgetAllDurableMapBaselines drops a pending signal', () => {
    openWindow() // window left OPEN — this one needs no extra step

    noteCoverageTransition(KEY, 'a', 'replaced')
    forgetAllDurableMapBaselines()

    write({ coverage: coverage({}) }, 'after-forget')

    expect(writeCount()).toBe(2)
    expect(onDisk()).toBe('opener')
    flush()
    expect(onDisk()).toBe('after-forget')
  })
})

describe('durableMapPersist — the gap boundary is structural, the end is not', () => {
  /**
   * The asymmetry the gap rule turns on.
   *
   * An in-place BOUNDARY advance — the same id's gap moving from
   * `{ start: 1000 }` to `{ start: 99000 }` — is the normal shape of a
   * multi-page forward catch-up, and losing it is not self-healing: the restored
   * stale anchor is closable by a later backward "load older" page where the
   * true anchor would have survived, leaving the hole above it unrecorded while
   * the forward cursor sits above it. So it force-flushes.
   */
  it('force-flushes an in-place gap boundary advance', () => {
    write({ gaps: gaps({ a: { start: 1000, startId: 'anchor-low' } }) }, 'baseline')
    write({ gaps: gaps({ a: { start: 1000, end: 900, startId: 'anchor-low' } }) }, 'opener')
    expect(writeCount()).toBe(2)

    write({ gaps: gaps({ a: { start: 99000, startId: 'anchor-high' } }) }, 'moved')

    expect(writeCount()).toBe(3)
    expect(onDisk()).toBe('moved')
  })

  /** `startId` alone can move while `start` stands still — an incomplete forward
   *  page whose `page.last` advances the id-exact cursor. Same class, same rule. */
  it('force-flushes a startId-only advance', () => {
    write({ gaps: gaps({ a: { start: 1000, startId: 'arc-1' } }) }, 'baseline')
    write({ gaps: gaps({ a: { start: 1000, end: 900, startId: 'arc-1' } }) }, 'opener')
    expect(writeCount()).toBe(2)

    write({ gaps: gaps({ a: { start: 1000, end: 900, startId: 'arc-2' } }) }, 'cursor-moved')

    expect(writeCount()).toBe(3)
    expect(onDisk()).toBe('cursor-moved')
  })

  /**
   * The other side of the asymmetry, and the reason the throttle still earns its
   * keep here: `end` moving down is the hole closing from BELOW, and a stale
   * un-closed gap only costs a redundant re-heal. Without this a rule that
   * force-flushed on ANY gap field change would pass every durability test in
   * the file — flushing more is never less durable.
   */
  it('leaves an end-only shrink throttled', () => {
    write({ gaps: gaps({ a: { start: 1000, end: 800, startId: 'anchor' } }) }, 'baseline')
    write({ gaps: gaps({ a: { start: 1000, end: 900, startId: 'anchor' } }) }, 'opener')
    expect(writeCount()).toBe(2)

    write({ gaps: gaps({ a: { start: 1000, end: 950, startId: 'anchor', endId: 'e' } }) }, 'shrunk')

    expect(writeCount()).toBe(2)
    expect(onDisk()).toBe('opener')
    flush()
    expect(onDisk()).toBe('shrunk')
  })
})
