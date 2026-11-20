import { describe, expect, it } from 'vitest'
import { forwardSourceIds, buildForwardedCopy, forwardableText, composeForwardWithCopy, forwardedCopyFallbackRange, composeForward, forwardFallbackRange, withoutForwardFallback, editableForward } from './forwardMessage'

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

// Piece 2 of the forward plan: a structured copy needs the claimed author and its quote is marked as the copy's fallback.
describe('forward composition with a copy', () => {
  const quote = { author: 'Bob', text: 'Ship it', from: 'room@c/Bob', timestamp: 5 }

  it('keeps the whole quoted body and marks its quote and link as the fallback of the copy', () => {
    const { body, references, forwarded } = composeForwardWithCopy(' Look ', link, quote)!
    expect(body).toBe(composeForward(' Look ', link, quote).body)
    expect(forwarded).toEqual({ from: 'room@c/Bob', text: 'Ship it', timestamp: 5, fallback: { begin: 5, end: body.length } })
    // The copy's marker is the only one: the link is a plain data reference.
    expect(references).toEqual([{ type: 'data', uri: link, begin: body.length - link.length, end: body.length }])
  })

  it('builds nothing without an author address or text', () => {
    expect(composeForwardWithCopy('Look', link, { author: 'Bob', text: 'hi' })).toBeNull()
    expect(composeForwardWithCopy('Look', link, undefined)).toBeNull()
  })

  it('hides the quote only for a copy that is read and not retracted', () => {
    const message = { body: `Look\n> Bob wrote:\n> hi\n${link}`, forwarded: { author: 'Bob', text: 'hi', fallback: { begin: 5, end: 5 + 18 + link.length, text: `> Bob wrote:\n> hi\n${link}` } } }
    expect(withoutForwardFallback(message, undefined, true).body).toBe('Look')
    expect(withoutForwardFallback({ ...message, isRetracted: true }, undefined, true).body).toBe(message.body)
    expect(forwardedCopyFallbackRange({ ...message, forwarded: undefined })).toBeUndefined()
    expect(withoutForwardFallback({ ...message, forwarded: { ...message.forwarded, fallback: { begin: 5, end: 9999, text: 'x' } } }, undefined, true).body).toBe(message.body)
  })

  it('needs an author address and text, and bounds the copied text', () => {
    expect(buildForwardedCopy({ author: 'Bob', text: 'hi' })).toBeNull()
    expect(buildForwardedCopy({ author: 'Bob', text: '  ', from: 'r@c/Bob' })).toBeNull()
    expect(buildForwardedCopy(undefined)).toBeNull()
    expect(Array.from(buildForwardedCopy({ author: 'Bob', text: 'a'.repeat(5000), from: 'r@c/Bob' })!.text)).toHaveLength(4000)
  })

  // FLM-153 piece 3: a one-to-one source has no room link; its content is quoted and copied.
  it('composes a one-to-one forward without a link, marking only the quote as the copy fallback', () => {
    const direct = { author: 'Bob', text: 'Ship it', from: 'bob@example.org', timestamp: 5, fromEncrypted: true }
    const plain = composeForward('Look', undefined, direct)
    expect(plain).toEqual({ body: 'Look\n> Bob wrote:\n> Ship it', references: [] })
    const { body, references, forwarded } = composeForwardWithCopy(' Look ', undefined, direct)!
    expect(body).toBe(plain.body)
    expect(references).toEqual([])
    expect(forwarded).toEqual({ from: 'bob@example.org', text: 'Ship it', timestamp: 5, fromEncrypted: true,
      fallback: { begin: 5, end: body.length } })
    expect(composeForwardWithCopy('', undefined, { ...direct, fromEncrypted: undefined })!.forwarded)
      .toEqual({ from: 'bob@example.org', text: 'Ship it', timestamp: 5, fallback: { begin: 0, end: '> Bob wrote:\n> Ship it'.length } })
  })

  it('flattens a comment and a copy into one readable text, alone or together', () => {
    expect(forwardableText(' Look ', { author: 'Carol', text: 'Ship it' })).toBe('Look\nCarol wrote:\nShip it')
    expect(forwardableText('', { author: 'Carol', text: 'Ship it' })).toBe('Carol wrote:\nShip it')
    expect(forwardableText('Look')).toBe('Look')
  })
})

// Captain's choice on FLM-332: the copy carries the original's ids for an exact match later.
describe('ids of the original in a forward', () => {
  it('names the sender id and, only where the archive is known, the archive that assigned the archive id', () => {
    expect(forwardSourceIds({ id: 'c1', originId: 'o1', stanzaId: 's1', type: 'groupchat' }, 'r@c.example.org'))
      .toEqual({ id: 'o1', stanzaId: 's1', stanzaIdBy: 'r@c.example.org' })
    // A direct message carries its authoritative own-archive pair, never a foreign stanza id beside it.
    expect(forwardSourceIds({ id: 'c1', stanzaId: 'foreign', ownArchiveId: 'own-9', ownArchiveBy: 'me@example.org', type: 'chat' }))
      .toEqual({ id: 'c1', stanzaId: 'own-9', stanzaIdBy: 'me@example.org' })
    expect(forwardSourceIds({ id: 'c1', stanzaId: 'foreign', type: 'chat' })).toEqual({ id: 'c1' })
  })

  it('keeps them on the structured copy and leaves an unarchived source with its id only', () => {
    const quote = { author: 'Bob', text: 'Ship it', from: 'bob@example.org', type: 'chat' as const, id: 'c1', stanzaId: 's1', stanzaIdBy: 'me@example.org' }
    expect(composeForwardWithCopy('', undefined, quote)!.forwarded).toMatchObject({ id: 'c1', stanzaId: 's1', stanzaIdBy: 'me@example.org' })
    expect(buildForwardedCopy({ ...quote, stanzaIdBy: undefined })).toEqual({ from: 'bob@example.org', text: 'Ship it', type: 'chat', id: 'c1' })
  })
})

describe('editing a forward', () => {
  const quoted = '> Bob wrote:\n> Ship it\n'
  it('offers only the comment of a forward with a link, and sets its quote aside', () => {
    const { body, references } = composeForward('Look', link, { author: 'Bob', text: 'Ship it' })
    expect(editableForward({ body, references })).toEqual({ body: 'Look', forwardQuote: `${quoted}${link}` })
  })

  it('offers only the comment of a forward with a shown copy', () => {
    const composed = composeForwardWithCopy('Look', undefined, { author: 'Bob', text: 'Ship it', from: 'bob@example.org' })!
    const range = composed.forwarded.fallback
    const forwarded = { author: 'Bob', text: 'Ship it', fallback: { ...range, text: composed.body.slice(range.begin, range.end) } }
    expect(editableForward({ body: composed.body, forwarded })).toEqual({ body: 'Look', forwardQuote: quoted.trimEnd() })
  })

  it('leaves an ordinary message, a retracted copy and an edited-away quote whole', () => {
    expect(editableForward({ body: 'Just text' })).toEqual({ body: 'Just text' })
    const composed = composeForwardWithCopy('Look', undefined, { author: 'Bob', text: 'Ship it', from: 'bob@example.org' })!
    const forwarded = { author: 'Bob', text: 'Ship it', fallback: { ...composed.forwarded.fallback, text: 'something else' } }
    expect(editableForward({ body: composed.body, forwarded })).toEqual({ body: composed.body })
  })
})
