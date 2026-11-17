import type { BaseMessage, DataReference, MentionReference, MessageReference } from '@fluux/sdk'

/** The source text a forward quotes: who wrote it and what it said. */
export interface ForwardQuote {
  author: string
  text: string
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
 */
export function composeForward(comment: string, link: string, quote?: ForwardQuote): { body: string; references: DataReference[] } {
  const lead = comment.trim() ? `${comment.trim()}\n` : ''
  const generated = quote?.text.trim() ? `${buildForwardQuote(quote)}\n${link}` : link
  const body = lead + generated
  const begin = lead.length + generated.length - link.length
  return {
    body,
    references: [{ type: 'data', uri: link, begin, end: begin + link.length,
      forwardFallback: { begin: lead.length, end: body.length } }],
  }
}

/** The marked quote and link a reader may hide once it shows the source itself. */
export function forwardFallbackRange(references?: MessageReference[]): { begin: number; end: number } | undefined {
  for (const reference of references ?? []) if (reference.type === 'data' && reference.forwardFallback) return reference.forwardFallback
  return undefined
}

/** Remove the marked range, and any mention that sat inside or after it. */
export function withoutForwardFallback(message: Pick<BaseMessage, 'body' | 'references'>, mentions?: MentionReference[]): {
  body: string
  mentions?: MentionReference[]
} {
  const range = forwardFallbackRange(message.references)
  if (!range) return { body: message.body, mentions }
  return {
    body: message.body.slice(0, range.begin).trimEnd(),
    mentions: mentions?.filter(mention => mention.end !== undefined && mention.end <= range.begin),
  }
}
