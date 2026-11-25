import type { TFunction } from 'i18next'
import { format } from 'date-fns'
import { DATE_OPERATORS, HAS_VALUES, searchInputTokens, parseRoomSender, localDayValue, type SearchFilterToken } from '@fluux/sdk'
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
  pickedFilter?: string
}

/** Someone `from:` can name: the value typed and the name shown. */
export interface SenderOption { value: string; label: string }

/** The word the caret is in, when it is the last one of the query. */
export function lastWord(query: string): string {
  const token = searchInputTokens(query).at(-1)
  return token?.end === query.length ? token.raw : ''
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

/** JSON quoting keeps whitespace, literal quotes and backslashes within one sender token. */
const quoted = (value: string) => (/[\s"\\]/.test(value) ? JSON.stringify(value) : value)

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
        .map(({ value, label }) => {
          const roomSender = parseRoomSender(value)
          return { id: `from-${value}`, insert: `${name}:${quoted(roomSender?.nick ?? value)}`, hintKey: '', label,
            ...(roomSender ? { pickedFilter: `from:${JSON.stringify(value)}` } : {}) }
        })
      const me = 'me'.startsWith(lower) && lower !== 'me' ? [{ id: 'from-me', insert: `${name}:me`, hintKey: 'search.values.mine' }] : []
      return [...me, ...people]
    }
    if (!(DATE_OPERATORS as readonly string[]).includes(op)) return []
    return dateValues(now)
      .filter(({ value }) => value.startsWith(partial) && value !== partial)
      .map(({ value, hintKey }) => ({ id: `${name}-${value}`, insert: `${name}:${value}`, hintKey }))
  }
  return []
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
  if (filter.op === 'from') return t('search.chip.from', { name: parseRoomSender(filter.value)?.nick ?? filter.value })
  if (filter.op === 'has') return t(`search.chip.${filter.value.toLowerCase()}`)
  if (!filter.range) return filter.raw
  const date = describeSpan(filter.range, lang)
  return t(`search.chip.${filter.op === 'during' ? 'on' : filter.op}`, { date })
}
