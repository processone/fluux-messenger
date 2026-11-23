import type { TFunction } from 'i18next'
import { format } from 'date-fns'
import { DATE_OPERATORS, HAS_VALUES, TOKEN_OPERATORS, localDayValue, removeSearchFilter, type SearchFilterToken } from '@fluux/sdk'
import { getDateLocale } from '@/utils/dateFormat'

/** One line of the operator autocomplete under the search field. */
export interface OperatorSuggestion {
  /** Stable key, also the option's DOM id suffix. */
  id: string
  /** What replaces the word being typed. */
  insert: string
  /** i18n key of the line's description. */
  hintKey: string
  /** A name shown instead of the hint (a contact or a room nick for `from:`). */
  label?: string
}

/** Someone `from:` can name: the value typed and the name shown. */
export interface SenderOption { value: string; label: string }

/** Operators offered while typing their name, in this order. `in:` only works first in the query. */
export const SEARCH_OPERATOR_NAMES = ['in', ...TOKEN_OPERATORS, ...DATE_OPERATORS] as const

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
/** A value with spaces goes in quotes, so the operator keeps it whole. */
const quoted = (value: string) => (/\s/.test(value) ? `"${value}"` : value)

export function operatorSuggestions(query: string, now = new Date(), senders: readonly SenderOption[] = []): OperatorSuggestion[] {
  const word = lastWord(query)
  const operator = /^([a-z]+):(.*)$/i.exec(word)
  if (operator) {
    const [, name, partial] = operator
    const lower = partial.replace(/^"/, '').toLowerCase()
    const op = name.toLowerCase()
    if (op === 'has') {
      return HAS_VALUES.filter((value) => value.startsWith(lower) && value !== lower)
        .map((value) => ({ id: `has-${value}`, insert: `${name}:${value}`, hintKey: `search.values.${value}` }))
    }
    if (op === 'is') {
      return 'mine'.startsWith(lower) && lower !== 'mine' ? [{ id: 'is-mine', insert: `${name}:mine`, hintKey: 'search.values.mine' }] : []
    }
    if (op === 'from') {
      const people = senders
        .filter(({ value, label }) => value.toLowerCase().startsWith(lower) || label.toLowerCase().startsWith(lower))
        .slice(0, 8)
        .map(({ value, label }) => ({ id: `from-${value}`, insert: `${name}:${quoted(value)}`, hintKey: '', label }))
      const me = 'me'.startsWith(lower) && lower !== 'me' ? [{ id: 'from-me', insert: `${name}:me`, hintKey: 'search.values.mine' }] : []
      return [...me, ...people]
    }
    if (!(DATE_OPERATORS as readonly string[]).includes(op)) return []
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
  if (!filter.valid) return filter.raw
  if (filter.op === 'is' || (filter.op === 'from' && filter.value.toLowerCase() === 'me')) return t('search.chip.mine')
  if (filter.op === 'from') return t('search.chip.from', { name: filter.value })
  if (filter.op === 'has') return t(`search.chip.${filter.value.toLowerCase()}`)
  if (!filter.range) return filter.raw
  const date = describeSpan(filter.range, lang)
  return t(`search.chip.${filter.op === 'during' ? 'on' : filter.op}`, { date })
}

/** Buttons that apply a filter without typing it; `from` and `date` start one and let the suggestions finish it. */
export const QUICK_FILTERS = ['image', 'link', 'file', 'from', 'date'] as const
export type QuickFilter = typeof QUICK_FILTERS[number]

function belongsTo(quick: QuickFilter, filter: SearchFilterToken): boolean {
  if (quick === 'from') return filter.op === 'from'
  if (quick === 'date') return (DATE_OPERATORS as readonly string[]).includes(filter.op)
  return filter.op === 'has' && filter.value.toLowerCase() === quick
}

/** Whether the query already holds a finished filter of this button. */
export function quickFilterActive(quick: QuickFilter, filters: readonly SearchFilterToken[]): boolean {
  return filters.some((filter) => !!filter.value && belongsTo(quick, filter))
}

/**
 * The query after pressing a quick filter button: an active one takes its
 * filters out; otherwise its operator goes at the end, `from:` and `on:` left
 * open so the suggestions offer people and dates.
 */
export function toggleQuickFilter(query: string, quick: QuickFilter, filters: readonly SearchFilterToken[]): string {
  const own = filters.filter((filter) => belongsTo(quick, filter))
  const without = own.reduce((rest, filter) => removeSearchFilter(rest, filter), query)
  if (quickFilterActive(quick, filters)) return without
  const insert = quick === 'from' ? 'from:' : quick === 'date' ? 'on:' : `has:${quick}`
  const base = without.trimEnd()
  return `${base ? `${base} ` : ''}${insert}${insert.endsWith(':') ? '' : ' '}`
}
