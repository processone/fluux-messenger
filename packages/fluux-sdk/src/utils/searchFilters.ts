/**
 * Search operators typed in the query: `after:`, `before:`, `on:` and `during:`
 * for dates, `from:`, `is:mine` and `has:` for who sent a message and what it holds.
 *
 * Dates read as the reader's own days ({@link localDayBounds}), in ISO order
 * (`2024-03-05`, `2024-03`, `2024`) or in the numeric order of their locale
 * (`05/03/2024` in French, `03/05/2024` in American English). A range is two
 * dates joined by `..`, both days included.
 *
 * @module SearchFilters
 */

import { localDayBounds } from './localDay'
import type { Message, RoomMessage } from '../core/types'

/** Operators that narrow a search by date. */
export const DATE_OPERATORS = ['after', 'before', 'on', 'during'] as const
export type DateOperator = typeof DATE_OPERATORS[number]
/** Operators that narrow a search by sender or content; they need the filter index. */
export const TOKEN_OPERATORS = ['from', 'is', 'has'] as const
export type TokenOperator = typeof TOKEN_OPERATORS[number]
export type SearchOperator = DateOperator | TokenOperator
/** Values of `has:`. */
export const HAS_VALUES = ['link', 'image', 'file', 'poll'] as const
export type HasValue = typeof HAS_VALUES[number]
/** Values of `is:`. */
export const IS_VALUES = ['mine'] as const

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
  /** Only the reader's own messages (`is:mine` or `from:me`). */
  mine?: boolean
  /** What every message must hold (`has:`). */
  has: HasValue[]
  /** Senders named by `from:`, as typed; each is a separate condition. */
  from: string[]
}

const OPERATOR_PATTERN = new RegExp(`(^|\\s)(${[...DATE_OPERATORS, ...TOKEN_OPERATORS].join('|')}):("[^"]*"?|\\S*)`, 'gi')

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
  let mine = false
  const has = new Set<HasValue>()
  const from: string[] = []
  const text = query.replace(OPERATOR_PATTERN, (raw, lead: string, op: string, rawValue: string) => {
    const value = rawValue.replace(/^"|"$/g, '')
    const operator = op.toLowerCase() as SearchOperator
    if ((TOKEN_OPERATORS as readonly string[]).includes(operator)) {
      const lower = value.toLowerCase()
      const isMine = (operator === 'is' && lower === 'mine') || (operator === 'from' && lower === 'me')
      const valid = isMine || (operator === 'has' && (HAS_VALUES as readonly string[]).includes(lower)) ||
        (operator === 'from' && value.trim().length > 0)
      filters.push({ op: operator, value, raw: raw.slice(lead.length), valid })
      if (isMine) mine = true
      else if (valid && operator === 'has') has.add(lower as HasValue)
      else if (valid && operator === 'from') from.push(value.trim())
      return lead
    }
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
  return {
    text, filters, has: [...has], from,
    ...(after !== undefined ? { after } : {}), ...(before !== undefined ? { before } : {}), ...(mine ? { mine } : {}),
  }
}

/** Whether the query asks for `from:`, `is:` or `has:`, which only the filter index can answer. */
export function hasTokenFilters(input: ParsedSearchInput): boolean {
  return !!input.mine || input.has.length > 0 || input.from.length > 0
}

// =============================================================================
// Filter tokens
// =============================================================================

/**
 * Reserved tokens the search index files next to a message's words. The leading
 * control character is one the tokenizer always splits on, so no typed word can
 * ever equal one of them.
 */
const MARK = '\u0001'

export const filterToken = {
  mine: `${MARK}is:mine`,
  has: (value: HasValue) => `${MARK}has:${value}`,
  /** The bare JID of a one-to-one sender. */
  from: (bareJid: string) => `${MARK}from:${bareJid.toLowerCase()}`,
  /** A room nick, kept so `from:<nick>` finds a sender without an occupant id. */
  nick: (nick: string) => `${MARK}nick:${nick.toLowerCase()}`,
  /** A room occupant id (XEP-0421), which outlives nick changes. */
  occupant: (occupantId: string) => `${MARK}occ:${occupantId}`,
}

/** The parts of a message its filter tokens read. */
export type FilterTokenSource = Pick<Message | RoomMessage, 'type' | 'from' | 'isOutgoing' | 'body' | 'attachment' | 'poll'> &
  { nick?: string; occupantId?: string }

const LINK_PATTERN = /(?:\bhttps?:\/\/|\bwww\.)\S/i
const IMAGE_EXTENSION = /\.(?:avif|bmp|gif|heic|jpe?g|png|svg|webp)(?:[?#]|$)/i

function isImage(attachment: NonNullable<FilterTokenSource['attachment']>): boolean {
  if (attachment.mediaType) return attachment.mediaType.startsWith('image/')
  return IMAGE_EXTENSION.test(attachment.name ?? '') || IMAGE_EXTENSION.test(attachment.url)
}

/**
 * The filter tokens of one message: who sent it (`from:`, `is:mine`) and what it
 * holds (`has:`). A file's own URL in the body does not count as a link.
 */
export function messageFilterTokens(message: FilterTokenSource): string[] {
  const tokens: string[] = []
  if (message.isOutgoing) tokens.push(filterToken.mine)
  if (message.type === 'groupchat') {
    if (message.nick) tokens.push(filterToken.nick(message.nick))
    if (message.occupantId) tokens.push(filterToken.occupant(message.occupantId))
  } else if (!message.isOutgoing && message.from) {
    tokens.push(filterToken.from(message.from.split('/')[0]))
  }
  const body = message.attachment ? (message.body ?? '').split(message.attachment.url).join(' ') : message.body ?? ''
  if (LINK_PATTERN.test(body)) tokens.push(filterToken.has('link'))
  if (message.attachment) {
    tokens.push(filterToken.has('file'))
    if (isImage(message.attachment)) tokens.push(filterToken.has('image'))
  }
  if (message.poll) tokens.push(filterToken.has('poll'))
  return tokens
}

/**
 * Whether a message carries at least one token of every group: the check the
 * index makes with its rows, done on a message in hand (an archive page).
 */
export function matchesFilterTokens(message: FilterTokenSource, groups: readonly (readonly string[])[]): boolean {
  if (groups.length === 0) return true
  const tokens = new Set(messageFilterTokens(message))
  return groups.every((group) => group.some((token) => tokens.has(token)))
}

/** The query without one of its operators, as typed. */
export function removeSearchFilter(query: string, filter: Pick<SearchFilterToken, 'raw'>): string {
  const index = query.indexOf(filter.raw)
  if (index === -1) return query
  return `${query.slice(0, index)}${query.slice(index + filter.raw.length)}`.replace(/\s+/g, ' ').trim()
}
