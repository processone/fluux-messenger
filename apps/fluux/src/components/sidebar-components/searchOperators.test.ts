import { describe, expect, it } from 'vitest'
import { parseSearchFilters } from '@fluux/sdk'
import { applySuggestion, describeSpan, lastWord, operatorSuggestions } from './searchOperators'

const NOW = new Date(2026, 10, 23, 15, 0)

describe('search operator suggestions', () => {
  it('offers operator names from two letters, and in: only as the first word', () => {
    expect(operatorSuggestions('a', NOW)).toEqual([])
    expect(operatorSuggestions('af', NOW).map(s => s.insert)).toEqual(['after:'])
    expect(operatorSuggestions('in', NOW).map(s => s.insert)).toEqual(['in:'])
    expect(operatorSuggestions('report in', NOW)).toEqual([])
    expect(operatorSuggestions('report o', NOW)).toEqual([])
    expect(operatorSuggestions('report on', NOW).map(s => s.insert)).toEqual(['on:'])
  })

  it('offers date values once the colon is typed, narrowed by what follows it', () => {
    expect(operatorSuggestions('after:', NOW).map(s => s.insert))
      .toEqual(['after:2026-11-23', 'after:2026-11-22', 'after:2026-11', 'after:2026'])
    expect(operatorSuggestions('x on:2026-11-2', NOW).map(s => s.insert)).toEqual(['on:2026-11-23', 'on:2026-11-22'])
    expect(operatorSuggestions('nope:', NOW)).toEqual([])
  })

  it('replaces the last word, leaving the caret after a colon or a space', () => {
    expect(lastWord('report af')).toBe('af')
    expect(applySuggestion('report af', { insert: 'after:' })).toBe('report after:')
    expect(applySuggestion('report after:2', { insert: 'after:2026' })).toBe('report after:2026 ')
  })

  it('names a day, a month, a year and a range in the interface language', () => {
    const span = (value: string) => parseSearchFilters(`on:${value}`, 'en').filters[0].range!
    expect(describeSpan(span('2024-03-05'), 'en')).toBe('Mar 5, 2024')
    expect(describeSpan(span('2024-03'), 'fr')).toBe('mars 2024')
    expect(describeSpan(span('2024'), 'en')).toBe('2024')
    expect(describeSpan(span('2024-03-01..2024-03-15'), 'en')).toBe('Mar 1, 2024 → Mar 15, 2024')
  })
})
