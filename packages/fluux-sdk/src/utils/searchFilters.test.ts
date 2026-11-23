import { describe, expect, it } from 'vitest'
import { filterToken, matchesFilterTokens, messageFilterTokens, parseDateSpan, parseSearchFilters, removeSearchFilter } from './searchFilters'

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

describe('sender and content operators', () => {
  it('reads from:, is:mine and has:, and reports values it does not know', () => {
    const parsed = parseSearchFilters('plan from:alice from:"Bob Smith" has:image has:nope is:mine', 'en')
    expect(parsed.text).toBe('plan')
    expect(parsed.from).toEqual(['alice', 'Bob Smith'])
    expect(parsed.has).toEqual(['image'])
    expect(parsed.mine).toBe(true)
    expect(parsed.filters.filter(f => !f.valid).map(f => f.raw)).toEqual(['has:nope'])
    expect(parseSearchFilters('from:me', 'en')).toMatchObject({ mine: true, from: [] })
  })
})

describe('message filter tokens', () => {
  const chat = { type: 'chat' as const, from: 'alice@example.com/phone', isOutgoing: false, body: 'hi' }

  it('names a one-to-one sender by bare JID, and the reader by is:mine', () => {
    expect(messageFilterTokens(chat)).toEqual([filterToken.from('alice@example.com')])
    expect(messageFilterTokens({ ...chat, isOutgoing: true })).toEqual([filterToken.mine])
  })

  it('names a room sender by nick and occupant id', () => {
    expect(messageFilterTokens({ type: 'groupchat', from: 'r@muc/Al', nick: 'Al', occupantId: 'occ-1', isOutgoing: false, body: '' }))
      .toEqual([filterToken.nick('al'), filterToken.occupant('occ-1')])
  })

  it('finds links, files, images and polls, but not a file URL as a link', () => {
    const tokens = (extra: object) => messageFilterTokens({ ...chat, ...extra }).filter(t => t.includes('has:'))
    expect(tokens({ body: 'see https://example.com/x' })).toEqual([filterToken.has('link')])
    expect(tokens({ body: 'www.example.com' })).toEqual([filterToken.has('link')])
    const url = 'https://up.example.com/a.png'
    expect(tokens({ body: url, attachment: { url } })).toEqual([filterToken.has('file'), filterToken.has('image')])
    expect(tokens({ body: '', attachment: { url: 'https://up/x', mediaType: 'application/pdf' } })).toEqual([filterToken.has('file')])
    expect(tokens({ body: 'Lunch?', poll: { title: 'Lunch?' } })).toEqual([filterToken.has('poll')])
  })

  it('needs one token of every group', () => {
    const groups = [[filterToken.has('link')], [filterToken.from('bob@example.com'), filterToken.from('alice@example.com')]]
    expect(matchesFilterTokens({ ...chat, body: 'https://x.y' }, groups)).toBe(true)
    expect(matchesFilterTokens({ ...chat, body: 'no link' }, groups)).toBe(false)
  })
})
