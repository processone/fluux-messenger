import { forwardedCopyQuoteRange } from '@fluux/sdk'
import type { BaseMessage, ForwardedCopy, DataReference, MentionReference, MessageReference } from '@fluux/sdk'

/** The source text a forward quotes: who wrote it and what it said. */
export interface ForwardQuote {
  author: string
  text: string
  /** Address of the claimed author, for a room message the occupant address; needed for a structured copy. */
  from?: string
  /** When the source was sent (ms since epoch). */
  timestamp?: number
  /** The source was read from an end-to-end encrypted chat; it may only go into an encrypted chat. */
  fromEncrypted?: boolean
  /** The source message's type, kept on the copy. */
  type?: 'chat' | 'groupchat'
}

const MAX_COPY_CHARACTERS = 4000

/** The structured copy of the source; null when it cannot be built (no author address or no text). */
export function buildForwardedCopy(quote?: ForwardQuote): { from: string; text: string; timestamp?: number; type?: 'chat' | 'groupchat' } | null {
  const text = quote?.text.trim()
  if (!quote?.from || !text) return null
  return {
    from: quote.from,
    text: Array.from(text).slice(0, MAX_COPY_CHARACTERS).join(''),
    ...(quote.timestamp !== undefined && { timestamp: quote.timestamp }),
    ...(quote.type && { type: quote.type }),
  }
}

/**
 * The readable text of a message that holds a structured copy: its displayed comment, then the
 * copied text under its claimed author, flattened into one text so a forward carries no nested copy.
 */
export function forwardableText(displayedBody: string, copy?: Pick<ForwardedCopy, 'author' | 'text'>): string {
  const comment = displayedBody.trim()
  const copied = copy?.text.trim()
  if (!copied) return comment
  return [comment, `${copy!.author || 'Unknown sender'} wrote:\n${copied}`].filter(Boolean).join('\n')
}

const MAX_QUOTE_CHARACTERS = 500

/** Plain-text attributed quote for clients that cannot show the forwarded message. */
export function buildForwardQuote({ author, text }: ForwardQuote): string {
  const characters = Array.from(text.trim())
  const clipped = characters.length > MAX_QUOTE_CHARACTERS
    ? `${characters.slice(0, MAX_QUOTE_CHARACTERS).join('').trimEnd()}…` : characters.join('')
  const lines = clipped.split('\n').map(line => `> ${line}`)
  return [`> ${author} wrote:`, ...lines].join('\n')
}

/**
 * Compose a forward: optional comment, then the generated quote and the room link. The
 * quote and link are marked as XEP-0428 fallback; the link also carries its data reference.
 * A one-to-one source has no link: its body is the comment and the quote, and nothing is
 * marked here (a copy to a chat marks the quote itself).
 */
export function composeForward(comment: string, link: string | undefined, quote?: ForwardQuote): { body: string; references: DataReference[] } {
  const lead = comment.trim() ? `${comment.trim()}\n` : ''
  const quoted = quote?.text.trim() ? buildForwardQuote(quote) : ''
  if (!link) return { body: (lead + quoted).trimEnd(), references: [] }
  const generated = quoted ? `${quoted}\n${link}` : link
  const body = lead + generated
  const begin = lead.length + generated.length - link.length
  return {
    body,
    references: [{ type: 'data', uri: link, begin, end: begin + link.length,
      forwardFallback: { begin: lead.length, end: body.length } }],
  }
}

/**
 * Compose a forward to a one-to-one chat: the same comment and quote as any forward (and the
 * link, for a room message), plus a structured copy of the source. The generated text is marked
 * as the fallback for the copy, so a reader that shows the copy hides it and every other reader
 * shows it. Nothing about the reader's support is checked. Null when no copy can be built.
 */
export function composeForwardWithCopy(comment: string, link: string | undefined, quote?: ForwardQuote): {
  body: string
  references: DataReference[]
  forwarded: { from: string; text: string; timestamp?: number; type?: 'chat' | 'groupchat'; fromEncrypted?: boolean; fallback: { begin: number; end: number } }
} | null {
  const copy = buildForwardedCopy(quote)
  if (!copy) return null
  const { body, references } = composeForward(comment, link, quote)
  const fallback = link ? forwardFallbackRange(references) : { begin: comment.trim() ? comment.trim().length + 1 : 0, end: body.length }
  if (!fallback) return null
  // The copy's own marker replaces the private one, so the range is declared once.
  return {
    body,
    references: references.map(ref => ref.type === 'data' ? { type: 'data' as const, uri: ref.uri, begin: ref.begin, end: ref.end } : ref),
    forwarded: { ...copy, ...(quote?.fromEncrypted && { fromEncrypted: true }), fallback },
  }
}

/** The marked quote and link a reader may hide once it shows the source itself. */
export function forwardFallbackRange(references?: MessageReference[]): { begin: number; end: number } | undefined {
  for (const reference of references ?? []) if (reference.type === 'data' && reference.forwardFallback) return reference.forwardFallback
  return undefined
}

/** The quote that only stands in for a copy the reader shows; undefined when there is no marked copy or the body changed since. */
export function forwardedCopyFallbackRange(message: Pick<BaseMessage, 'body' | 'forwarded' | 'isRetracted'>): { begin: number; end: number } | undefined {
  return forwardedCopyQuoteRange(message)
}

/**
 * Remove only the marked [begin, end) interval, keeping text on both sides. A mention
 * after it moves up with the text; one inside it is dropped. The range is a forward's
 * marked quote and link, or the quote a shown copy replaces.
 */
export function withoutForwardFallback(message: Pick<BaseMessage, 'body' | 'references' | 'forwarded' | 'isRetracted'>, mentions?: MentionReference[], copyShown = false): {
  body: string
  mentions?: MentionReference[]
} {
  const range = copyShown ? forwardedCopyFallbackRange(message) : forwardFallbackRange(message.references)
  if (!range || range.end > message.body.length) return { body: message.body, mentions }
  const before = message.body.slice(0, range.begin).trimEnd()
  const rest = message.body.slice(range.end)
  const after = rest.trimStart()
  const afterStart = range.end + rest.length - after.length
  const joiner = before && after ? '\n' : ''
  const moved = before.length + joiner.length - afterStart
  return {
    body: before + joiner + after,
    mentions: mentions?.flatMap(mention => mention.end <= before.length ? [mention]
      : mention.begin >= afterStart ? [{ ...mention, begin: mention.begin + moved, end: mention.end + moved }] : []),
  }
}
