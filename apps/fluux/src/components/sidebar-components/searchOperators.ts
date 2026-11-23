import type { TFunction } from 'i18next'
import { format } from 'date-fns'
import { DATE_OPERATORS, localDayValue, type SearchFilterToken } from '@fluux/sdk'
import { getDateLocale } from '@/utils/dateFormat'

/** One line of the operator autocomplete under the search field. */
export interface OperatorSuggestion {
  /** Stable key, also the option's DOM id suffix. */
  id: string
  /** What replaces the word being typed. */
  insert: string
  /** i18n key of the line's description. */
  hintKey: string
}

/** Operators offered while typing their name, in this order. `in:` only works first in the query. */
export const SEARCH_OPERATOR_NAMES = ['in', ...DATE_OPERATORS] as const

/** The word the caret is in, when it is the last one of the query. */
export function lastWord(query: string): string {
  return /(\S*)$/.exec(query)?.[1] ?? ''
}

/** The query with its last word replaced; a completed value gets a space so the next word can start. */
export function applySuggestion(query: string, suggestion: Pick<OperatorSuggestion, 'insert'>): string {
  const head = query.slice(0, query.length - lastWord(query).length)
  return `${head}${suggestion.insert}${suggestion.insert.endsWith(':') ? '' : ' '}`
}

function dateValues(now: Date): Array<{ value: string; hintKey: string }> {
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  return [
    { value: localDayValue(now), hintKey: 'search.dates.today' },
    { value: localDayValue(yesterday), hintKey: 'search.dates.yesterday' },
    { value: localDayValue(now).slice(0, 7), hintKey: 'search.dates.thisMonth' },
    { value: String(now.getFullYear()), hintKey: 'search.dates.thisYear' },
  ]
}

/**
 * Suggestions for the last word of the query: operator names while one is being
 * typed (two letters at least, so ordinary words rarely trigger it), then values
 * once the colon is there.
 */
export function operatorSuggestions(query: string, now = new Date()): OperatorSuggestion[] {
  const word = lastWord(query)
  const operator = /^([a-z]+):(.*)$/i.exec(word)
  if (operator) {
    const [, name, partial] = operator
    if (!(DATE_OPERATORS as readonly string[]).includes(name.toLowerCase())) return []
    return dateValues(now)
      .filter(({ value }) => value.startsWith(partial) && value !== partial)
      .map(({ value, hintKey }) => ({ id: `${name}-${value}`, insert: `${name}:${value}`, hintKey }))
  }
  if (word.length < 2) return []
  const firstWord = query.trimStart() === word
  return SEARCH_OPERATOR_NAMES
    .filter((name) => name.startsWith(word.toLowerCase()) && (name !== 'in' || firstWord))
    .map((name) => ({ id: name, insert: `${name}:`, hintKey: `search.operators.${name}` }))
}

/** A span as a reader names it: a day, a month, a year, or two days. */
export function describeSpan(range: { start: number; end: number }, lang: string): string {
  const locale = getDateLocale(lang)
  const start = new Date(range.start)
  const last = new Date(range.end - 1)
  const firstOfMonth = start.getDate() === 1 && new Date(range.end).getDate() === 1
  if (start.toDateString() === last.toDateString()) return format(start, 'PP', { locale })
  if (firstOfMonth && start.getMonth() === 0 && last.getMonth() === 11 && start.getFullYear() === last.getFullYear()) {
    return format(start, 'yyyy', { locale })
  }
  if (firstOfMonth && start.getMonth() === last.getMonth() && start.getFullYear() === last.getFullYear()) {
    return format(start, 'LLLL yyyy', { locale })
  }
  return `${format(start, 'PP', { locale })} → ${format(last, 'PP', { locale })}`
}

/** The text of a filter chip: what the operator keeps, or what was typed when it was not understood. */
export function filterChipLabel(filter: SearchFilterToken, t: TFunction, lang: string): string {
  if (!filter.valid || !filter.range) return filter.raw
  const date = describeSpan(filter.range, lang)
  return t(`search.chip.${filter.op === 'during' ? 'on' : filter.op}`, { date })
}
