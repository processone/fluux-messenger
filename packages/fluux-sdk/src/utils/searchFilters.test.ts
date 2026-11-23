import { describe, expect, it } from 'vitest'
import { parseDateSpan, parseSearchFilters, removeSearchFilter } from './searchFilters'

const day = (y: number, m: number, d: number) => new Date(y, m - 1, d).getTime()

describe('search date operators', () => {
  it('reads ISO days, months and years as local spans', () => {
    expect(parseDateSpan('2024-03-05')).toEqual({ start: day(2024, 3, 5), end: day(2024, 3, 6) })
    expect(parseDateSpan('2024-03')).toEqual({ start: day(2024, 3, 1), end: day(2024, 4, 1) })
    expect(parseDateSpan('2024')).toEqual({ start: day(2024, 1, 1), end: day(2025, 1, 1) })
    expect(parseDateSpan('2024/3/5')).toEqual({ start: day(2024, 3, 5), end: day(2024, 3, 6) })
  })

  it('reads numeric dates in the order of the locale', () => {
    expect(parseDateSpan('05/03/2024', 'fr')).toEqual({ start: day(2024, 3, 5), end: day(2024, 3, 6) })
    expect(parseDateSpan('05.03.2024', 'de')).toEqual({ start: day(2024, 3, 5), end: day(2024, 3, 6) })
    expect(parseDateSpan('03/05/2024', 'en-US')).toEqual({ start: day(2024, 3, 5), end: day(2024, 3, 6) })
  })

  it('refuses dates that do not exist', () => {
    expect(parseDateSpan('2024-02-30')).toBeNull()
    expect(parseDateSpan('2024-13')).toBeNull()
    expect(parseDateSpan('31/02/2024', 'fr')).toBeNull()
    expect(parseDateSpan('yesterday')).toBeNull()
    expect(parseDateSpan('2024-03-10..2024-03-01')).toBeNull()
  })

  it('reads a range with both days included', () => {
    expect(parseDateSpan('2024-03-01..2024-03-15')).toEqual({ start: day(2024, 3, 1), end: day(2024, 3, 16) })
  })

  it('takes the operators out of the words and intersects their spans', () => {
    const parsed = parseSearchFilters('meeting after:2024-03-01 notes before:2024-04', 'en')
    expect(parsed.text).toBe('meeting notes')
    expect(parsed.after).toBe(day(2024, 3, 2))
    expect(parsed.before).toBe(day(2024, 4, 1))
    expect(parsed.filters.map(f => f.raw)).toEqual(['after:2024-03-01', 'before:2024-04'])

    const on = parseSearchFilters('on:2024-03-05 during:2024', 'en')
    expect(on).toMatchObject({ text: '', after: day(2024, 3, 5), before: day(2024, 3, 6) })
  })

  it('reports a value it does not understand and narrows nothing with it', () => {
    const parsed = parseSearchFilters('hello after:soon on:', 'en')
    expect(parsed.text).toBe('hello')
    expect(parsed.filters).toEqual([
      { op: 'after', value: 'soon', raw: 'after:soon', valid: false },
      { op: 'on', value: '', raw: 'on:', valid: false },
    ])
    expect(parsed.after).toBeUndefined()
  })

  it('leaves words with a colon that are not operators', () => {
    expect(parseSearchFilters('see https://example.com re:topic', 'en').text).toBe('see https://example.com re:topic')
    expect(parseSearchFilters('soon:2024', 'en').filters).toEqual([])
  })

  it('removes one operator from the query as typed', () => {
    expect(removeSearchFilter('a after:2024 b', { raw: 'after:2024' })).toBe('a b')
  })
})
