/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest'
import {
  rangeIndices,
  rangeIds,
  selectAllRange,
  pruneRange,
  selectionReducer,
  collectRangeMeta,
  type CopyRange,
} from './messageRangeSelection'

const IDS = ['a', 'b', 'c', 'd']

describe('rangeIndices', () => {
  it('returns min/max regardless of anchor/focus direction', () => {
    expect(rangeIndices(IDS, { anchorId: 'b', focusId: 'd' })).toEqual({ start: 1, end: 3 })
    expect(rangeIndices(IDS, { anchorId: 'd', focusId: 'b' })).toEqual({ start: 1, end: 3 })
  })
  it('handles anchor === focus (single)', () => {
    expect(rangeIndices(IDS, { anchorId: 'c', focusId: 'c' })).toEqual({ start: 2, end: 2 })
  })
  it('returns null when an endpoint is missing', () => {
    expect(rangeIndices(IDS, { anchorId: 'b', focusId: 'z' })).toBeNull()
    expect(rangeIndices(IDS, { anchorId: 'z', focusId: 'b' })).toBeNull()
  })
})

describe('rangeIds', () => {
  it('returns the inclusive slice in array order', () => {
    expect(rangeIds(IDS, { anchorId: 'd', focusId: 'b' })).toEqual(['b', 'c', 'd'])
  })
  it('returns empty for an invalid range', () => {
    expect(rangeIds(IDS, { anchorId: 'b', focusId: 'z' })).toEqual([])
  })
})

describe('selectAllRange', () => {
  it('returns first..last', () => {
    expect(selectAllRange(IDS)).toEqual({ anchorId: 'a', focusId: 'd' })
  })
  it('returns a single-id range for one message', () => {
    expect(selectAllRange(['x'])).toEqual({ anchorId: 'x', focusId: 'x' })
  })
  it('returns null for an empty list', () => {
    expect(selectAllRange([])).toBeNull()
  })
})

describe('pruneRange', () => {
  it('keeps a valid range', () => {
    const r: CopyRange = { anchorId: 'a', focusId: 'c' }
    expect(pruneRange(r, IDS)).toBe(r)
  })
  it('drops the range when an endpoint vanished', () => {
    expect(pruneRange({ anchorId: 'a', focusId: 'gone' }, IDS)).toBeNull()
  })
  it('passes null through', () => {
    expect(pruneRange(null, IDS)).toBeNull()
  })
})

describe('selectionReducer', () => {
  it('extendTo begins the range when state is null', () => {
    expect(selectionReducer(null, { type: 'extendTo', id: 'b' }, IDS)).toEqual({ anchorId: 'b', focusId: 'b' })
  })
  it('extendTo keeps the anchor and moves the focus', () => {
    expect(
      selectionReducer({ anchorId: 'b', focusId: 'b' }, { type: 'extendTo', id: 'd' }, IDS),
    ).toEqual({ anchorId: 'b', focusId: 'd' })
  })
  it('extendTo ignores an unknown id', () => {
    const s: CopyRange = { anchorId: 'a', focusId: 'b' }
    expect(selectionReducer(s, { type: 'extendTo', id: 'zzz' }, IDS)).toBe(s)
  })
  it('selectAll selects the whole list', () => {
    expect(selectionReducer(null, { type: 'selectAll' }, IDS)).toEqual({ anchorId: 'a', focusId: 'd' })
  })
  it('clear resets to null', () => {
    expect(selectionReducer({ anchorId: 'a', focusId: 'd' }, { type: 'clear' }, IDS)).toBeNull()
  })
})

describe('collectRangeMeta', () => {
  const messages = [
    { id: 'a', from: 'Alice', time: '10:00', body: 'one', date: '2024-01-15' },
    { id: 'b', from: 'Bob', time: '10:01', body: 'two', date: '2024-01-15' },
    { id: 'c', from: 'Alice', time: '10:02', body: 'three', date: '2024-01-15' },
  ]
  const fmt = (m: (typeof messages)[number]) => ({
    id: m.id,
    from: m.from,
    time: m.time,
    body: m.body,
    date: m.date,
  })

  it('slices the range and maps each message via formatForCopy', () => {
    expect(collectRangeMeta(messages, { anchorId: 'a', focusId: 'b' }, fmt)).toEqual([
      { id: 'a', from: 'Alice', time: '10:00', body: 'one', date: '2024-01-15' },
      { id: 'b', from: 'Bob', time: '10:01', body: 'two', date: '2024-01-15' },
    ])
  })
  it('returns empty for an invalid range', () => {
    expect(collectRangeMeta(messages, { anchorId: 'a', focusId: 'gone' }, fmt)).toEqual([])
  })
})
