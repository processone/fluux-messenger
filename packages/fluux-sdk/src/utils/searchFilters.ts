/**
 * Search operators typed in the query: `after:`, `before:`, `on:` and `during:`.
 *
 * Dates read as the reader's own days ({@link localDayBounds}), in ISO order
 * (`2024-03-05`, `2024-03`, `2024`) or in the numeric order of their locale
 * (`05/03/2024` in French, `03/05/2024` in American English). A range is two
 * dates joined by `..`, both days included.
 *
 * @module SearchFilters
 */

import { localDayBounds } from './localDay'

/** Operators that narrow a search by date. */
export const DATE_OPERATORS = ['after', 'before', 'on', 'during'] as const
export type DateOperator = typeof DATE_OPERATORS[number]
export type SearchOperator = DateOperator

/** One operator found in the query. */
export interface SearchFilterToken {
  op: SearchOperator
  /** The value after the colon, without quotes; empty while still being typed. */
  value: string
  /** The operator exactly as typed, so it can be taken out of the query again. */
  raw: string
  /** The instants a date operator covers: `start` included, `end` excluded. */
  range?: { start: number; end: number }
  /** Whether the value was understood; an operator that was not narrows nothing. */
  valid: boolean
}

/** A query split into its words and its operators. */
export interface ParsedSearchInput {
  /** The words left once the operators are taken out. */
  text: string
  filters: SearchFilterToken[]
  /** Messages at or after this instant (epoch ms), from the date operators together. */
  after?: number
  /** Messages strictly before this instant (epoch ms). */
  before?: number
}

const OPERATOR_PATTERN = new RegExp(`(^|\\s)(${DATE_OPERATORS.join('|')}):("[^"]*"?|\\S*)`, 'gi')

/** Whether the locale writes the day before the month in numeric dates (`05/03` for 5 March). */
function dayFirst(locale?: string): boolean {
  try {
    const parts = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'numeric', year: 'numeric' })
      .formatToParts(new Date(2001, 10, 22))
    const order = parts.map((part) => part.type)
    return order.indexOf('day') < order.indexOf('month')
  } catch {
    return false
  }
}

/** A day, month or year, checked so `2024-02-31` is refused rather than rolled into March. */
function calendarSpan(year: number, month?: number, day?: number): { start: number; end: number } | null {
  if (month === undefined) return { start: new Date(year, 0, 1).getTime(), end: new Date(year + 1, 0, 1).getTime() }
  if (month < 1 || month > 12) return null
  if (day === undefined) return { start: new Date(year, month - 1, 1).getTime(), end: new Date(year, month, 1).getTime() }
  const pad = (n: number) => String(n).padStart(2, '0')
  const bounds = localDayBounds(`${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}`)
  if (!bounds || bounds.start.getDate() !== day || bounds.start.getMonth() !== month - 1) return null
  return { start: bounds.start.getTime(), end: bounds.end.getTime() }
}

/**
 * The instants one date covers, from local midnight to local midnight: a day,
 * a month (`2024-03`), a year (`2024`) or a range (`2024-03-01..2024-03-15`).
 */
export function parseDateSpan(value: string, locale?: string): { start: number; end: number } | null {
  const trimmed = value.trim()
  const range = trimmed.split('..')
  if (range.length === 2) {
    const from = parseDateSpan(range[0], locale)
    const to = parseDateSpan(range[1], locale)
    return from && to && from.start < to.end ? { start: from.start, end: to.end } : null
  }
  const iso = /^(\d{4})(?:[-/.](\d{1,2})(?:[-/.](\d{1,2}))?)?$/.exec(trimmed)
  if (iso) {
    const [year, month, day] = iso.slice(1).map((part) => (part === undefined ? undefined : Number(part)))
    return calendarSpan(year as number, month, day)
  }
  const numeric = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(trimmed)
  if (numeric) {
    const [first, second, year] = numeric.slice(1).map(Number)
    return dayFirst(locale) ? calendarSpan(year, second, first) : calendarSpan(year, first, second)
  }
  return null
}

/**
 * Split a query into words and operators. `after:` keeps what comes after the
 * whole day (or month) it names and `before:` what comes before it; `on:` and
 * `during:` keep the span itself. Several date operators keep what all of them
 * keep. An operator whose value is not understood is reported but narrows nothing.
 */
export function parseSearchFilters(query: string, locale?: string): ParsedSearchInput {
  const filters: SearchFilterToken[] = []
  let after: number | undefined
  let before: number | undefined
  const text = query.replace(OPERATOR_PATTERN, (raw, lead: string, op: string, rawValue: string) => {
    const value = rawValue.replace(/^"|"$/g, '')
    const operator = op.toLowerCase() as SearchOperator
    const range = value ? parseDateSpan(value, locale) ?? undefined : undefined
    filters.push({ op: operator, value, raw: raw.slice(lead.length), ...(range ? { range } : {}), valid: !!range })
    if (range) {
      const low = operator === 'after' ? range.end : operator === 'before' ? undefined : range.start
      const high = operator === 'before' ? range.start : operator === 'after' ? undefined : range.end
      if (low !== undefined) after = after === undefined ? low : Math.max(after, low)
      if (high !== undefined) before = before === undefined ? high : Math.min(before, high)
    }
    return lead
  }).replace(/\s+/g, ' ').trim()
  return { text, filters, ...(after !== undefined ? { after } : {}), ...(before !== undefined ? { before } : {}) }
}

/** The query without one of its operators, as typed. */
export function removeSearchFilter(query: string, filter: Pick<SearchFilterToken, 'raw'>): string {
  const index = query.indexOf(filter.raw)
  if (index === -1) return query
  return `${query.slice(0, index)}${query.slice(index + filter.raw.length)}`.replace(/\s+/g, ' ').trim()
}
