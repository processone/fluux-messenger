/**
 * Property tests for room history-gap interval algebra.
 *
 * A `GapInterval` is a KNOWN hole: messages are held below `start` and, when
 * `end` is set, above it. Two laws follow from that reading and hold across
 * every transition here:
 *
 *  - a gap is well formed, `end > start`. An inverted or empty interval is not a
 *    hole, and anything downstream that renders "Load missing messages" from it
 *    would be offering to fetch nothing.
 *  - reconciling a gap against a page only ever SHRINKS or CLEARS it. A gap that
 *    could widen would keep re-opening ground already fetched.
 *
 * The detection side has the opposite bias, and it is the safety-critical one:
 * a seam is planted only on structural proof of disconnection, never on a
 * heuristic, because a false seam shows the user a hole that is not there.
 */
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  closeGapWithBackwardPage,
  computeGapEnd,
  detectFetchLatestSeam,
  messagePageExtent,
  newestMessageStanzaId,
  oldestMessageStanzaId,
  serializeGaps,
  deserializeGaps,
  syncGap,
  type GapInterval,
} from './mamGap'

/** Timestamps from a tiny pool so pages overlap, abut and interleave. */
const TS = fc.integer({ min: 0, max: 6 })
const JIDS = ['room-a@conf', 'room-b@conf'] as const

const messageArb = fc.record({
  timestamp: fc.option(TS, { nil: undefined }).map((t) => (t === undefined ? undefined : new Date(t))),
  stanzaId: fc.option(fc.constantFrom('s1', 's2', 's3'), { nil: undefined }),
})
const pageArb = fc.array(messageArb, { maxLength: 6 })

/** A well-formed gap, as every producer in this module yields. */
const gapArb: fc.Arbitrary<GapInterval> = fc
  .tuple(TS, fc.option(TS, { nil: undefined }))
  .map(([start, rawEnd]) => ({
    start,
    ...(rawEnd !== undefined && rawEnd > start ? { end: rawEnd } : {}),
  }))

const wellFormed = (gap: GapInterval | undefined) => {
  if (!gap) return
  if (gap.end !== undefined) expect(gap.end).toBeGreaterThan(gap.start)
}

describe('gap intervals stay well formed', () => {
  it('detectFetchLatestSeam never plants an inverted or empty gap', () => {
    fc.assert(
      fc.property(pageArb, fc.nat(6), fc.nat(3), fc.option(TS, { nil: undefined }), (page, newCount, patched, heldBelow) => {
        wellFormed(detectFetchLatestSeam(page, newCount, patched, heldBelow))
      }),
      { numRuns: 3000 },
    )
  })

  it('closeGapWithBackwardPage never yields an inverted or empty gap', () => {
    fc.assert(
      fc.property(gapArb, pageArb, fc.boolean(), (gap, page, complete) => {
        wellFormed(closeGapWithBackwardPage(gap, messagePageExtent(page), complete))
      }),
      { numRuns: 3000 },
    )
  })
})

describe('reconciling a gap only shrinks it', () => {
  it('never moves the start, and never widens the end', () => {
    fc.assert(
      fc.property(gapArb, pageArb, fc.boolean(), (gap, page, complete) => {
        const next = closeGapWithBackwardPage(gap, messagePageExtent(page), complete)
        if (next === undefined) return // cleared, which is the strongest shrink

        // The lower edge is held history below the hole; a backward page cannot
        // move it, only the region above can close in.
        expect(next.start).toBe(gap.start)

        if (gap.end === undefined) return // was open to live: any end is a shrink
        expect(next.end).toBeDefined()
        expect(next.end!).toBeLessThanOrEqual(gap.end)
      }),
      { numRuns: 3000 },
    )
  })

  it('is idempotent: re-applying the same page changes nothing further', () => {
    fc.assert(
      fc.property(gapArb, pageArb, fc.boolean(), (gap, page, complete) => {
        const extent = messagePageExtent(page)
        const once = closeGapWithBackwardPage(gap, extent, complete)
        if (once === undefined) return
        expect(closeGapWithBackwardPage(once, extent, complete)).toEqual(once)
      }),
      { numRuns: 3000 },
    )
  })

  it('leaves the gap alone for a page that sits entirely below it', () => {
    // Older-region pagination says nothing about a hole above it — not even a
    // `complete` page, whose completeness is about the archive start.
    fc.assert(
      fc.property(gapArb, pageArb, fc.boolean(), (gap, page, complete) => {
        const extent = messagePageExtent(page)
        if (extent.newestTs === undefined || extent.newestTs > gap.start) return
        expect(closeGapWithBackwardPage(gap, extent, complete)).toBe(gap)
      }),
      { numRuns: 3000 },
    )
  })
})

describe('seam detection stays conservative', () => {
  it('refuses to plant a seam on any evidence of connection', () => {
    // A dedupe hit or an archive-id backfill both prove the page touches held
    // history, so there is no disconnection to record.
    fc.assert(
      fc.property(
        pageArb.filter((p) => p.length > 0),
        fc.nat(6),
        fc.nat(3),
        fc.option(TS, { nil: undefined }),
        (page, newCount, patched, heldBelow) => {
          const connected = newCount < page.length || patched > 0
          if (!connected) return
          expect(detectFetchLatestSeam(page, newCount, patched, heldBelow)).toBeUndefined()
        },
      ),
      { numRuns: 3000 },
    )
  })

  it('refuses to plant a seam with nothing held below, or on an interleaving page', () => {
    fc.assert(
      fc.property(pageArb, fc.option(TS, { nil: undefined }), (page, heldBelow) => {
        const seam = detectFetchLatestSeam(page, page.length, 0, heldBelow)
        if (heldBelow === undefined) {
          expect(seam).toBeUndefined()
          return
        }
        const { oldestTs } = messagePageExtent(page)
        if (oldestTs !== undefined && oldestTs <= heldBelow) expect(seam).toBeUndefined()
      }),
      { numRuns: 3000 },
    )
  })

  it('anchors a planted seam on the two proven boundaries', () => {
    fc.assert(
      fc.property(pageArb, fc.option(TS, { nil: undefined }), (page, heldBelow) => {
        const seam = detectFetchLatestSeam(page, page.length, 0, heldBelow)
        if (!seam) return
        expect(seam.start).toBe(heldBelow)
        expect(seam.end).toBe(messagePageExtent(page).oldestTs)
      }),
      { numRuns: 3000 },
    )
  })
})

describe('page extent and cursor helpers', () => {
  it('messagePageExtent brackets exactly the timestamps present', () => {
    fc.assert(
      fc.property(pageArb, (page) => {
        const stamps = page.map((m) => m.timestamp?.getTime()).filter((t): t is number => t !== undefined)
        const { oldestTs, newestTs } = messagePageExtent(page)
        if (stamps.length === 0) {
          expect(oldestTs).toBeUndefined()
          expect(newestTs).toBeUndefined()
          return
        }
        expect(oldestTs).toBe(Math.min(...stamps))
        expect(newestTs).toBe(Math.max(...stamps))
      }),
      { numRuns: 3000 },
    )
  })

  it('computeGapEnd is the least timestamp strictly above the start', () => {
    fc.assert(
      fc.property(pageArb, TS, (page, start) => {
        const above = page
          .map((m) => m.timestamp?.getTime())
          .filter((t): t is number => t !== undefined && t > start)
        const end = computeGapEnd(page, start)
        if (above.length === 0) {
          expect(end).toBeUndefined()
          return
        }
        expect(end).toBe(Math.min(...above))
        expect(end!).toBeGreaterThan(start)
      }),
      { numRuns: 3000 },
    )
  })

  it('newestMessageStanzaId skips id-less messages, oldestMessageStanzaId does not', () => {
    // The asymmetry is deliberate on the newest side, which must not degrade to
    // undefined because an unreflected own-send sits at the top. The oldest side
    // takes whatever the oldest row carries, so an id-less oldest row yields no
    // cursor even when a slightly newer one has an id.
    fc.assert(
      fc.property(pageArb, (page) => {
        const withIds = page.filter((m) => m.stanzaId && m.timestamp)
        const newest = newestMessageStanzaId(page)
        if (withIds.length === 0) {
          expect(newest).toBeUndefined()
        } else {
          const best = withIds.reduce((a, b) => (b.timestamp!.getTime() > a.timestamp!.getTime() ? b : a))
          expect(newest).toBe(best.stanzaId)
        }

        const timed = page.filter((m) => m.timestamp)
        const oldestRow = timed.length
          ? timed.reduce((a, b) => (b.timestamp!.getTime() < a.timestamp!.getTime() ? b : a))
          : undefined
        expect(oldestMessageStanzaId(page)).toBe(oldestRow?.stanzaId)
      }),
      { numRuns: 3000 },
    )
  })
})

describe('syncGap map transitions', () => {
  const mapArb = fc.array(fc.tuple(fc.constantFrom(...JIDS), gapArb), { maxLength: 2 }).map(
    (entries) => new Map<string, GapInterval>(entries),
  )

  it('is copy-on-write: the same reference exactly when nothing changed', () => {
    fc.assert(
      fc.property(mapArb, fc.constantFrom(...JIDS), gapArb, (gaps, jid, gap) => {
        const next = syncGap(gaps, jid, gap.start, gap.end, gap.startId, gap.endId)
        const before = gaps.get(jid)
        const same = next === gaps
        const equal =
          before?.start === gap.start &&
          before?.end === gap.end &&
          before?.startId === gap.startId &&
          before?.endId === gap.endId
        expect(same).toBe(equal)
      }),
      { numRuns: 3000 },
    )
  })

  it('only ever touches the addressed entry', () => {
    fc.assert(
      fc.property(mapArb, fc.constantFrom(...JIDS), fc.option(gapArb, { nil: undefined }), (gaps, jid, gap) => {
        const next = syncGap(gaps, jid, gap?.start, gap?.end, gap?.startId, gap?.endId)
        for (const [key, value] of gaps) {
          if (key === jid) continue
          expect(next.get(key)).toBe(value)
        }
      }),
      { numRuns: 3000 },
    )
  })

  it('clears the entry exactly when no start is given', () => {
    fc.assert(
      fc.property(mapArb, fc.constantFrom(...JIDS), (gaps, jid) => {
        expect(syncGap(gaps, jid, undefined, undefined).has(jid)).toBe(false)
      }),
      { numRuns: 3000 },
    )
  })

  it('round-trips through serialisation, and never throws on hostile input', () => {
    fc.assert(
      fc.property(mapArb, (gaps) => {
        expect(deserializeGaps(serializeGaps(gaps))).toEqual(gaps)
      }),
      { numRuns: 3000 },
    )
    fc.assert(
      fc.property(fc.string(), (raw) => {
        expect(() => deserializeGaps(raw)).not.toThrow()
      }),
      { numRuns: 3000 },
    )
  })
})
