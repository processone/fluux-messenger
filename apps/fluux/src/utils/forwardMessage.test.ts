import { describe, expect, it } from 'vitest'
import { composeForward, forwardFallbackRange, withoutForwardFallback } from './forwardMessage'

const link = 'xmpp:design@conference.fluux.chat?join;msg=1731490000123456'

// Approved forward plan: comment, attributed plain-text quote and link; the quote and
// link are fallback a reader hides once it can show the source.
describe('forward composition', () => {
  it('puts the comment first and marks the quote and link as one fallback range', () => {
    const { body, references } = composeForward('  Look 🔗 ', link, { author: 'Bob', text: 'Ship it' })
    expect(body).toBe(`Look 🔗\n> Bob wrote:\n> Ship it\n${link}`)
    const range = forwardFallbackRange(references)!
    expect(body.slice(0, range.begin)).toBe('Look 🔗\n')
    expect(body.slice(range.begin)).toBe(`> Bob wrote:\n> Ship it\n${link}`)
    expect(body.slice(references[0].begin, references[0].end)).toBe(link)
  })

  it('sends only the marked link when the source cannot be quoted', () => {
    const { body, references } = composeForward('', link)
    expect(body).toBe(link)
    expect(references[0].forwardFallback).toEqual({ begin: 0, end: link.length })
  })

  it('clips a very long quote', () => {
    const { body } = composeForward('', link, { author: 'Bob', text: 'a'.repeat(900) })
    expect(body).toContain(`> ${'a'.repeat(500)}…\n`)
    expect(body).not.toContain('a'.repeat(501))
  })

  it('hides the marked range and any mention that reached into it', () => {
    const { body, references } = composeForward('Hi @Ann', link, { author: 'Bob', text: 'Ship it' })
    const mention = (begin: number, end: number) => ({ type: 'mention' as const, uri: 'xmpp:r@c/Ann', begin, end })
    const shown = withoutForwardFallback({ body, references }, [mention(3, 7), mention(body.length - 4, body.length)])
    expect(shown.body).toBe('Hi @Ann')
    expect(shown.mentions).toEqual([mention(3, 7)])
  })

  it('removes only the marked interval, keeping text and mentions after it', () => {
    const { body, references } = composeForward('Hi', link, { author: 'Bob', text: 'Ship it' })
    const tail = `${body}\nthanks @Ann`
    const mention = { type: 'mention' as const, uri: 'xmpp:r@c/Ann', begin: tail.length - 4, end: tail.length }
    const shown = withoutForwardFallback({ body: tail, references }, [mention])
    expect(shown.body).toBe('Hi\nthanks @Ann')
    expect(shown.mentions).toEqual([{ ...mention, begin: shown.body.length - 4, end: shown.body.length }])
  })

  it('leaves a message without a marker alone', () => {
    const message = { body: `see ${link}`, references: [{ type: 'data' as const, uri: link, begin: 4, end: 4 + link.length }] }
    expect(withoutForwardFallback(message).body).toBe(message.body)
  })
})
