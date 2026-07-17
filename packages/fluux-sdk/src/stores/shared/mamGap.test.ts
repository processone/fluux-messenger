import { describe, it, expect } from 'vitest'
import {
  computeGapEnd,
  syncGap,
  serializeGaps,
  deserializeGaps,
  messagePageExtent,
  detectFetchLatestSeam,
  closeGapWithBackwardPage,
  syncGapAfterArchiveMerge,
  newestMessageStanzaId,
  type GapInterval,
  type ArchiveMergeGapInput,
} from './mamGap'

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

describe('syncGap', () => {
  it('records a gap interval when start is defined', () => {
    const result = syncGap(new Map(), 'room@x', 1000, 5000)
    expect(result.get('room@x')).toEqual({ start: 1000, end: 5000 })
  })

  it('omits end when undefined (gap extends to live)', () => {
    const result = syncGap(new Map(), 'room@x', 1000, undefined)
    expect(result.get('room@x')).toEqual({ start: 1000 })
  })

  it('clears the gap when start is undefined', () => {
    const gaps = new Map<string, GapInterval>([['room@x', { start: 1000, end: 5000 }]])
    const result = syncGap(gaps, 'room@x', undefined, undefined)
    expect(result.has('room@x')).toBe(false)
  })

  it('returns the same map reference when nothing changes (no spurious writes)', () => {
    const gaps = new Map<string, GapInterval>([['room@x', { start: 1000, end: 5000 }]])
    expect(syncGap(gaps, 'room@x', 1000, 5000)).toBe(gaps)
  })

  it('returns the same map reference when clearing an already-absent gap', () => {
    const gaps = new Map<string, GapInterval>()
    expect(syncGap(gaps, 'room@x', undefined, undefined)).toBe(gaps)
  })
})

describe('serializeGaps / deserializeGaps', () => {
  it('round-trips a gap map', () => {
    const gaps = new Map<string, GapInterval>([
      ['a@x', { start: 1000, end: 5000 }],
      ['b@x', { start: 2000 }],
    ])
    const restored = deserializeGaps(serializeGaps(gaps))
    expect(restored.get('a@x')).toEqual({ start: 1000, end: 5000 })
    expect(restored.get('b@x')).toEqual({ start: 2000 })
  })

  it('returns an empty map for malformed JSON', () => {
    expect(deserializeGaps('not json').size).toBe(0)
  })
})

const msg = (iso: string) => ({ timestamp: new Date(iso) })
const ts = (iso: string) => new Date(iso).getTime()

describe('messagePageExtent', () => {
  it('returns min/max timestamps, robust to unsorted input', () => {
    const extent = messagePageExtent([msg('2026-07-10T00:00:00Z'), msg('2026-07-06T00:00:00Z'), msg('2026-07-08T00:00:00Z')])
    expect(extent).toEqual({ oldestTs: ts('2026-07-06T00:00:00Z'), newestTs: ts('2026-07-10T00:00:00Z') })
  })

  it('skips messages without timestamps; empty input yields undefined bounds', () => {
    expect(messagePageExtent([{}, msg('2026-07-06T00:00:00Z')])).toEqual({
      oldestTs: ts('2026-07-06T00:00:00Z'), newestTs: ts('2026-07-06T00:00:00Z'),
    })
    expect(messagePageExtent([])).toEqual({ oldestTs: undefined, newestTs: undefined })
  })
})

describe('detectFetchLatestSeam', () => {
  const page = [msg('2026-07-14T00:00:00Z'), msg('2026-07-15T00:00:00Z')]
  const heldBelowTs = ts('2026-07-06T00:00:00Z')

  it('plants a seam when the page lands entirely above held history with no overlap', () => {
    expect(detectFetchLatestSeam(page, 2, 0, heldBelowTs)).toEqual({
      start: heldBelowTs,               // newest pre-existing message below
      end: ts('2026-07-14T00:00:00Z'),  // oldest fetched message
    })
  })

  it('no seam on dedupe overlap (some fetched messages already held)', () => {
    expect(detectFetchLatestSeam(page, 1, 0, heldBelowTs)).toBeUndefined()
  })

  it('no seam on archive-id backfill (reflection patched onto held messages)', () => {
    expect(detectFetchLatestSeam(page, 2, 1, heldBelowTs)).toBeUndefined()
  })

  it('no seam when nothing is held below', () => {
    expect(detectFetchLatestSeam(page, 2, 0, undefined)).toBeUndefined()
  })

  it('no seam when the page interleaves with held history (ambiguous)', () => {
    // Held newest (July 14T12:00) sits inside the page span — not entirely above.
    expect(detectFetchLatestSeam(page, 2, 0, ts('2026-07-14T12:00:00Z'))).toBeUndefined()
  })

  it('no seam for an empty page or a page with no timestamps', () => {
    expect(detectFetchLatestSeam([], 0, 0, heldBelowTs)).toBeUndefined()
    expect(detectFetchLatestSeam([{}], 1, 0, heldBelowTs)).toBeUndefined()
  })

  it('no seam from an id alone: newestHeldBelowId with undefined newestHeldBelowTs', () => {
    // A seam's start comes from the TIMESTAMP; an id without a timestamp must
    // not be enough to invent one.
    expect(detectFetchLatestSeam(page, 2, 0, undefined, 'held-id-without-ts')).toBeUndefined()
  })
})

describe('closeGapWithBackwardPage', () => {
  const gap: GapInterval = { start: ts('2026-07-06T00:00:00Z'), end: ts('2026-07-14T00:00:00Z') }

  it('clears the gap when the page crosses it (oldest fetched reaches held history below)', () => {
    const page = { oldestTs: ts('2026-07-05T00:00:00Z'), newestTs: ts('2026-07-14T06:00:00Z') }
    expect(closeGapWithBackwardPage(gap, page, false)).toBeUndefined()
  })

  it('shrinks the gap when the page reaches into it from above', () => {
    const page = { oldestTs: ts('2026-07-10T00:00:00Z'), newestTs: ts('2026-07-14T06:00:00Z') }
    expect(closeGapWithBackwardPage(gap, page, false)).toEqual({
      start: gap.start, end: ts('2026-07-10T00:00:00Z'),
    })
  })

  it('ignores a page entirely below the gap (older-region pagination says nothing)', () => {
    const page = { oldestTs: ts('2026-07-01T00:00:00Z'), newestTs: ts('2026-07-05T00:00:00Z') }
    expect(closeGapWithBackwardPage(gap, page, false)).toBe(gap)
    // Even archive-start (complete=true) below the gap must NOT clear it.
    expect(closeGapWithBackwardPage(gap, page, true)).toBe(gap)
  })

  it('is reference-stable even when pageOldestId is passed (unchanged branch ignores it)', () => {
    const page = { oldestTs: ts('2026-07-01T00:00:00Z'), newestTs: ts('2026-07-05T00:00:00Z') }
    const result = closeGapWithBackwardPage(gap, page, false, 'should-not-appear')
    expect(result).toBe(gap)
  })

  it('clears the gap when a page from at/above it reaches archive start (complete)', () => {
    const page = { oldestTs: ts('2026-07-08T00:00:00Z'), newestTs: ts('2026-07-14T06:00:00Z') }
    expect(closeGapWithBackwardPage(gap, page, true)).toBeUndefined()
  })

  it('ignores an empty page (no positional info), even when complete', () => {
    expect(closeGapWithBackwardPage(gap, { oldestTs: undefined, newestTs: undefined }, true)).toBe(gap)
  })

  it('ignores a page entirely above the gap end (recent-region pagination not yet at the seam)', () => {
    const page = { oldestTs: ts('2026-07-14T12:00:00Z'), newestTs: ts('2026-07-15T00:00:00Z') }
    expect(closeGapWithBackwardPage(gap, page, false)).toBe(gap)
  })

  it('shrinks an open-ended gap (end undefined) instead of ignoring it', () => {
    const openGap: GapInterval = { start: ts('2026-07-06T00:00:00Z') }
    const page = { oldestTs: ts('2026-07-10T00:00:00Z'), newestTs: ts('2026-07-15T00:00:00Z') }
    expect(closeGapWithBackwardPage(openGap, page, false)).toEqual({
      start: openGap.start, end: ts('2026-07-10T00:00:00Z'),
    })
  })
})

describe('syncGapAfterArchiveMerge', () => {
  const id = 'room@conference.example.com'
  const base = (over: Partial<ArchiveMergeGapInput>): ArchiveMergeGapInput => ({
    gaps: new Map(),
    id,
    direction: 'backward',
    complete: false,
    forwardGapTimestamp: undefined,
    merged: [],
    fetched: [],
    newMessagesCount: 0,
    patchedCount: 0,
    isFetchLatest: false,
    newestHeldBelowTs: undefined,
    preserveGapMarker: false,
    ...over,
  })

  it('forward: mirrors forwardGapTimestamp into the map with computeGapEnd (existing behavior)', () => {
    const merged = [msg('2026-07-06T00:00:00Z'), msg('2026-07-15T00:00:00Z')]
    const out = syncGapAfterArchiveMerge(base({
      direction: 'forward', forwardGapTimestamp: ts('2026-07-06T00:00:00Z'), merged,
    }))
    expect(out.get(id)).toEqual({ start: ts('2026-07-06T00:00:00Z'), end: ts('2026-07-15T00:00:00Z') })
  })

  it('forward resync: preserves endId when the end timestamp is unchanged', () => {
    const start = ts('2026-07-01T00:00:00Z')
    const end = ts('2026-07-14T00:00:00Z')
    const gaps = new Map([[id, { start, end, startId: 's1', endId: 'e1' }]])
    // Merged still has an above-gap message at exactly `end` — computeGapEnd
    // resolves to the same value, so the recorded endId survives.
    const merged = [msg('2026-07-10T00:00:00Z'), msg('2026-07-14T00:00:00Z')]
    const out = syncGapAfterArchiveMerge(base({
      direction: 'forward', gaps, forwardGapTimestamp: ts('2026-07-10T00:00:00Z'),
      merged, lastFetchedArchiveId: 's2',
    }))
    expect(out.get(id)).toEqual({ start: ts('2026-07-10T00:00:00Z'), end, startId: 's2', endId: 'e1' })
  })

  it('forward resync: preserves startId when the merge has no lastFetchedArchiveId (rsm.last)', () => {
    const start = ts('2026-07-01T00:00:00Z')
    const end = ts('2026-07-14T00:00:00Z')
    const gaps = new Map([[id, { start, end, startId: 's1', endId: 'e1' }]])
    const merged = [msg('2026-07-14T00:00:00Z')]
    const out = syncGapAfterArchiveMerge(base({
      direction: 'forward', gaps, forwardGapTimestamp: start, merged,
      // No lastFetchedArchiveId — an incomplete forward merge without rsm.last.
    }))
    expect(out.get(id)).toEqual({ start, end, startId: 's1', endId: 'e1' })
  })

  it('forward resync: drops endId when the end timestamp moves (id for the new edge is unknown)', () => {
    const start = ts('2026-07-01T00:00:00Z')
    const end = ts('2026-07-14T00:00:00Z')
    const gaps = new Map([[id, { start, end, startId: 's1', endId: 'e1' }]])
    // A newer message now sits above the old end — the gap's end edge moved.
    const merged = [msg('2026-07-10T00:00:00Z'), msg('2026-07-20T00:00:00Z')]
    const out = syncGapAfterArchiveMerge(base({
      direction: 'forward', gaps, forwardGapTimestamp: ts('2026-07-10T00:00:00Z'),
      merged, lastFetchedArchiveId: 's2',
    }))
    expect(out.get(id)).toEqual({
      start: ts('2026-07-10T00:00:00Z'), end: ts('2026-07-20T00:00:00Z'), startId: 's2',
    })
    expect(out.get(id)?.endId).toBeUndefined()
  })

  it('forward resync: a brand-new gap (no existing entry) still stamps only startId, never a phantom endId', () => {
    const merged = [msg('2026-07-06T00:00:00Z'), msg('2026-07-15T00:00:00Z')]
    const out = syncGapAfterArchiveMerge(base({
      direction: 'forward', forwardGapTimestamp: ts('2026-07-06T00:00:00Z'), merged,
      lastFetchedArchiveId: 's1',
    }))
    expect(out.get(id)).toEqual({ start: ts('2026-07-06T00:00:00Z'), end: ts('2026-07-15T00:00:00Z'), startId: 's1' })
  })

  it('forward: clears the gap when forwardGapTimestamp is undefined (complete catch-up)', () => {
    const gaps = new Map([[id, { start: 1000, end: 5000 }]])
    const out = syncGapAfterArchiveMerge(base({ direction: 'forward', gaps, complete: true }))
    expect(out.has(id)).toBe(false)
  })

  it('preserveGapMarker: returns the map untouched for BOTH directions', () => {
    const gaps = new Map([[id, { start: 1000, end: 5000 }]])
    expect(syncGapAfterArchiveMerge(base({ direction: 'forward', gaps, preserveGapMarker: true }))).toBe(gaps)
    expect(syncGapAfterArchiveMerge(base({ gaps, preserveGapMarker: true, isFetchLatest: true }))).toBe(gaps)
  })

  it('backward formation: fetch-latest page disjoint above held history plants a seam', () => {
    const fetched = [msg('2026-07-14T00:00:00Z'), msg('2026-07-15T00:00:00Z')]
    const out = syncGapAfterArchiveMerge(base({
      fetched, newMessagesCount: 2, isFetchLatest: true,
      newestHeldBelowTs: ts('2026-07-06T00:00:00Z'),
    }))
    expect(out.get(id)).toEqual({ start: ts('2026-07-06T00:00:00Z'), end: ts('2026-07-14T00:00:00Z') })
  })

  it('backward formation: NOT planted for a plain pagination page (isFetchLatest=false)', () => {
    const fetched = [msg('2026-07-14T00:00:00Z')]
    const out = syncGapAfterArchiveMerge(base({
      fetched, newMessagesCount: 1, newestHeldBelowTs: ts('2026-07-06T00:00:00Z'),
    }))
    expect(out.has(id)).toBe(false)
  })

  it('backward closure: an existing gap takes priority over formation and shrinks/clears', () => {
    const gaps = new Map([[id, { start: ts('2026-07-01T00:00:00Z'), end: ts('2026-07-14T00:00:00Z') }]])
    const fetched = [msg('2026-07-10T00:00:00Z'), msg('2026-07-14T06:00:00Z')]
    const out = syncGapAfterArchiveMerge(base({
      gaps, fetched, newMessagesCount: 2, isFetchLatest: true, // fetch-latest flag must NOT re-plant
      newestHeldBelowTs: ts('2026-06-01T00:00:00Z'),
    }))
    expect(out.get(id)).toEqual({ start: ts('2026-07-01T00:00:00Z'), end: ts('2026-07-10T00:00:00Z') })
  })

  it('backward no-op: returns the SAME map reference when nothing changes', () => {
    const gaps = new Map([[id, { start: ts('2026-07-06T00:00:00Z'), end: ts('2026-07-14T00:00:00Z') }]])
    const fetched = [msg('2026-07-01T00:00:00Z')] // entirely below the gap
    const out = syncGapAfterArchiveMerge(base({ gaps, fetched, newMessagesCount: 1 }))
    expect(out).toBe(gaps)
  })
})

describe('newestMessageStanzaId', () => {
  it('returns the stanzaId of the newest-timestamped message when it carries one', () => {
    const messages = [
      { timestamp: new Date('2026-07-10T00:00:00Z'), stanzaId: 'old' },
      { timestamp: new Date('2026-07-15T00:00:00Z'), stanzaId: 'newest' },
      { timestamp: new Date('2026-07-12T00:00:00Z'), stanzaId: 'mid' },
    ]
    expect(newestMessageStanzaId(messages)).toBe('newest')
  })

  it('falls back to the next-newest message that HAS a stanzaId when the newest lacks one', () => {
    // The newest-timestamped message (own-sent pre-echo) has no stanzaId yet —
    // must not silently drop the id-exact resume cursor.
    const messages = [
      { timestamp: new Date('2026-07-10T00:00:00Z'), stanzaId: 'archived' },
      { timestamp: new Date('2026-07-15T00:00:00Z') }, // newest, id-less
    ]
    expect(newestMessageStanzaId(messages)).toBe('archived')
  })

  it('returns undefined when no message carries a stanzaId', () => {
    const messages = [
      { timestamp: new Date('2026-07-10T00:00:00Z') },
      { timestamp: new Date('2026-07-15T00:00:00Z') },
    ]
    expect(newestMessageStanzaId(messages)).toBeUndefined()
  })

  it('returns undefined for an empty array', () => {
    expect(newestMessageStanzaId([])).toBeUndefined()
  })
})

describe('GapInterval coverage ids', () => {
  it('detectFetchLatestSeam stamps the last-downloaded id below and the first held id above', () => {
    const fetched = [
      { timestamp: new Date('2026-07-16T10:00:00Z'), stanzaId: 'win-oldest' },
      { timestamp: new Date('2026-07-16T11:00:00Z'), stanzaId: 'win-newest' },
    ]
    const seam = detectFetchLatestSeam(fetched, 2, 0, new Date('2026-06-01T10:00:00Z').getTime(), 'cov-42')
    expect(seam).toMatchObject({ startId: 'cov-42', endId: 'win-oldest' })
  })

  it('closeGapWithBackwardPage moves endId down with the shrinking edge', () => {
    const gap = { start: 1000, end: 5000, startId: 'cov-42', endId: 'old-top' }
    const page = { oldestTs: 3000, newestTs: 4500 }
    const next = closeGapWithBackwardPage(gap, page, false, 'page-oldest-id')
    expect(next).toMatchObject({ start: 1000, end: 3000, startId: 'cov-42', endId: 'page-oldest-id' })
  })

  it('deserializeGaps tolerates legacy entries without ids', () => {
    const legacy = JSON.stringify([['a@b.c', { start: 1000, end: 2000 }]])
    expect(deserializeGaps(legacy).get('a@b.c')).toEqual({ start: 1000, end: 2000 })
  })
})
