import { describe, it, expect } from 'vitest'
import { stripQuotedLines } from './previewQuotes'
import { formatMessagePreview } from './messagePreview'

// Intent (FLM-537): previews drop every `>` line outside code fences; a quote-only text keeps its quote.
describe('stripQuotedLines', () => {
  it.each([
    ['plain text is untouched', 'Hello > world', 'Hello > world'],
    ['leading quote', '> Bob: hi\nMy reply', 'My reply'],
    ['nested and later quotes', 'A\n>> deep\nB\n> q\nC', 'A\nB\nC'],
    ['quote-only keeps its marker', '> Bob: hi\n> more', '> Bob: hi\n> more'],
    ['quote-only with blank lines', '> one\n\n> two', '> one\n\n> two'],
    ['quote inside a fence is code', 'x\n```\n> keep\n```\n> drop\ny', 'x\n```\n> keep\n```\ny'],
    ['fence closed on one line', '```a```\n> drop\nz', '```a```\nz'],
    ['indented quote is not a quote line', '> old\n  > keep\nreply', '  > keep\nreply'],
    ['empty', '', ''],
  ])('%s', (_name, input, expected) => {
    expect(stripQuotedLines(input)).toBe(expected)
  })
})

describe('stripQuotedLines idempotence', () => {
  it.each(['> old\n  > keep\nreply', '> a\n> b', 'x\n> q\n\n y', '\n\n> q\n z'])('%j', input => {
    const once = stripQuotedLines(input)
    expect(stripQuotedLines(once)).toBe(once)
  })
})

describe('formatMessagePreview dropQuotes', () => {
  it('drops quotes on a message without a reply tag', () => {
    expect(formatMessagePreview({ body: '> q\nmine' }, { dropQuotes: true })).toBe('mine')
  })
  it('keeps a quote-only reply visible', () => {
    expect(formatMessagePreview({ body: '> Bob: hi', replyTo: { id: '1' } }, { dropQuotes: true })).toBe('> Bob: hi')
  })
  it('keeps nested quotes without the option (reply cards)', () => {
    expect(formatMessagePreview({ body: 'a\n> q' })).toBe('a\n> q')
  })
})
