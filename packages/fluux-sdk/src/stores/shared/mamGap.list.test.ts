import { describe, it, expect } from 'vitest'
import {
  syncGapAfterArchiveMerge,
  healGapsWithForwardPage,
  normalizeGapList,
  setGapList,
  deserializeGaps,
  serializeGaps,
  gapMapFromPersisted,
  findOpenGap,
  type ArchiveMergeGapInput,
  type GapInterval,
  type GapMap,
} from './mamGap'

const ID = 'xsf@muc.xmpp.org'
const d = (iso: string) => new Date(iso).getTime()
const msg = (iso: string, stanzaId?: string) => ({ timestamp: new Date(iso), ...(stanzaId ? { stanzaId } : {}) })

function merge(gaps: GapMap, over: Partial<ArchiveMergeGapInput>): GapMap {
  return syncGapAfterArchiveMerge({
    gaps,
    id: ID,
    direction: 'forward',
    complete: false,
    merged: [],
    fetched: [],
    newMessagesCount: over.fetched?.length ?? 0,
    patchedCount: 0,
    isFetchLatest: false,
    newestHeldBelowTs: undefined,
    preserveGapMarker: false,
    ...over,
  })
}

describe('gap list: a second hole is recorded next to an older one', () => {
  // An older hole (Aug 27 → Aug 31) is recorded; the cache then holds history up
  // to Sept 1. Catch-up walks forward from that top edge, stops at the page cap,
  // and bridges to live with a fetch-latest that lands today.
  const older: GapInterval = { start: d('2026-08-27T11:17:48Z'), end: d('2026-08-31T06:08:54Z'), startId: 'a27' }
  const topEdge = d('2026-09-01T22:30:00Z')

  it('records both holes after a capped walk from the top edge and a fetch-latest', () => {
    let gaps: GapMap = new Map([[ID, [older]]])

    gaps = merge(gaps, {
      walkOriginTs: topEdge,
      fetched: [msg('2026-09-02T08:00:00Z', 's1'), msg('2026-09-02T09:00:00Z', 's2')],
      lastFetchedArchiveId: 's2',
    })
    gaps = merge(gaps, {
      direction: 'backward',
      isFetchLatest: true,
      fetched: [msg('2026-10-06T20:03:00Z', 'l1'), msg('2026-10-06T20:35:00Z', 'l2')],
    })

    expect(gaps.get(ID)).toEqual([
      older,
      { start: d('2026-09-02T09:00:00Z'), startId: 's2', end: d('2026-10-06T20:03:00Z'), endId: 'l1' },
    ])
  })

  it('records a disjoint fetch-latest seam even when an older hole is recorded', () => {
    const gaps = merge(new Map([[ID, [older]]]), {
      direction: 'backward',
      isFetchLatest: true,
      fetched: [msg('2026-10-06T20:03:00Z', 'l1'), msg('2026-10-06T20:35:00Z', 'l2')],
      newestHeldBelowTs: topEdge,
      newestHeldBelowId: 'top',
    })

    expect(gaps.get(ID)).toEqual([
      older,
      { start: topEdge, startId: 'top', end: d('2026-10-06T20:03:00Z'), endId: 'l1' },
    ])
  })
})

describe('healGapsWithForwardPage', () => {
  const base = { lastId: 'x', complete: false, allowCreate: true, merged: [] }
  const a: GapInterval = { start: 100, end: 200, startId: 'a' }
  const b: GapInterval = { start: 300, end: 400, startId: 'b' }

  it('leaves gaps below the walk origin untouched, even when the walk reaches live', () => {
    expect(healGapsWithForwardPage([a, b], { ...base, originTs: 250, newestTs: 500, complete: true })).toEqual([a])
  })

  it('moves the start of the gap the walk reached and keeps its upper edge', () => {
    expect(healGapsWithForwardPage([a, b], { ...base, originTs: 100, newestTs: 150 }))
      .toEqual([{ start: 150, end: 200, startId: 'x' }, b])
  })

  it('removes a gap once the walk reaches its upper edge and continues into the next one', () => {
    expect(healGapsWithForwardPage([a, b], { ...base, originTs: 100, newestTs: 350 }))
      .toEqual([{ start: 350, end: 400, startId: 'x' }])
  })

  it('does not move a gap the walk has not reached yet', () => {
    expect(healGapsWithForwardPage([a, b], { ...base, originTs: 100, newestTs: 250 }))
      .toEqual([b])
  })

  it('opens a gap only when nothing is recorded at or above the origin', () => {
    expect(healGapsWithForwardPage([a], { ...base, originTs: 500, newestTs: 600 }))
      .toEqual([a, { start: 600, startId: 'x' }])
    expect(healGapsWithForwardPage([a], { ...base, originTs: 500, newestTs: 600, allowCreate: false }))
      .toEqual([a])
  })

  it('heals the gaps a fixed-window repair crosses without opening one', () => {
    expect(healGapsWithForwardPage([a, b], { ...base, originTs: 50, newestTs: 900, complete: true, allowCreate: false }))
      .toEqual([])
  })

  it('advances only the resume cursor of the gap a signal-only walk started at', () => {
    expect(healGapsWithForwardPage([a, b], { ...base, originTs: 100, newestTs: undefined, lastId: 'sig' }))
      .toEqual([{ ...a, startId: 'sig' }, b])
    expect(healGapsWithForwardPage([a, b], { ...base, originTs: 50, newestTs: undefined, lastId: 'sig' }))
      .toEqual([a, b])
  })
})

describe('bounded and windowed forward pages', () => {
  it('ignore the gaps when the walk has no origin', () => {
    const gaps: GapMap = new Map([[ID, [{ start: 100, end: 200 }]]])
    expect(merge(gaps, { fetched: [msg('1970-01-01T00:00:00.150Z')], complete: true })).toBe(gaps)
  })
})

describe('gap list normalization', () => {
  it('orders gaps and unions overlapping ones', () => {
    expect(normalizeGapList([
      { start: 300, end: 400, endId: 'e4' },
      { start: 100, end: 350, startId: 's1', endId: 'e3' },
      { start: 500 },
    ])).toEqual([
      { start: 100, end: 400, startId: 's1', endId: 'e4' },
      { start: 500 },
    ])
  })

  it('drops invalid intervals and removes the entry when nothing remains', () => {
    const gaps: GapMap = new Map([[ID, [{ start: 1, end: 2 }]]])
    expect(setGapList(gaps, ID, [{ start: 5, end: 5 }]).has(ID)).toBe(false)
  })

  it('returns the same map when the list is unchanged', () => {
    const gaps: GapMap = new Map([[ID, [{ start: 1, end: 2 }]]])
    expect(setGapList(gaps, ID, [{ start: 1, end: 2 }])).toBe(gaps)
  })

  it('reports an open gap only when the newest gap extends to live', () => {
    expect(findOpenGap([{ start: 1, end: 2 }, { start: 3 }])).toEqual({ start: 3 })
    expect(findOpenGap([{ start: 1, end: 2 }])).toBeUndefined()
  })
})

describe('gap persistence', () => {
  it('reads the single-interval shape saved before entities held several gaps', () => {
    const legacy = JSON.stringify([[ID, { start: 1, end: 2, startId: 'a' }]])
    expect(deserializeGaps(legacy).get(ID)).toEqual([{ start: 1, end: 2, startId: 'a' }])
  })

  it('round-trips the list shape', () => {
    const gaps: GapMap = new Map([[ID, [{ start: 1, end: 2 }, { start: 3 }]]])
    expect(deserializeGaps(serializeGaps(gaps))).toEqual(gaps)
  })

  it('skips malformed entries instead of failing the whole map', () => {
    const gaps = gapMapFromPersisted([[ID, { start: 'x' }], ['ok@x', [{ start: 1 }]], 'junk'])
    expect(Array.from(gaps.keys())).toEqual(['ok@x'])
  })
})
